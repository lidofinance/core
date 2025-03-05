/*****
 * operatorGridDemo.js
 *
 * Пример, где:
 *  - В одной группе может быть несколько Tier
 *  - В группе есть несколько операторов
 *  - У каждого оператора может быть несколько Vault'ов
 *  - Каждый новый Vault автоматически «попадает» в следующий Tier (по round-robin)
 *  - Минтим / сжигаем шары (учитывая лимиты и прогресс) на уровне конкретного Vault
 *  - Визуализируем структуру с помощью "ascii прогрессбаров" и раскраски (chalk)
 *****/

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chalk = require("chalk"); // Если используете CommonJS, замените на: const chalk = require('chalk');

/********************************
 *    СТРУКТУРА ДАННЫХ operatorGrid
 *******************************/

/**
 * Глобальный объект operatorGrid
 * Формат:
 * {
 *   groups: {
 *     [groupId: string]: {
 *       shareLimit: number,
 *       mintedShares: number,
 *       tiers: {
 *         [tierId: string]: {
 *           shareLimit: number,
 *           mintedShares: number,
 *           reserveRatio: number,
 *           reserveRatioThreshold: number
 *         }
 *       },
 *       operators: {
 *         [operatorId: string]: {
 *           vaults: {
 *             [vaultId: string]: {
 *               mintedShares: number,
 *               tierId: string
 *             }
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 */
const operatorGrid = {
  groups: {},
};

/********************************
 *    ФУНКЦИИ РАБОТЫ С ДАННЫМИ
 *******************************/

/**
 * Добавить новую группу.
 *
 * @param {string} groupId
 * @param {number} shareLimit - общий лимит на всю группу
 */
function addGroup(groupId, shareLimit) {
  if (operatorGrid.groups[groupId]) {
    throw new Error(`Group ${groupId} already exists`);
  }
  operatorGrid.groups[groupId] = {
    shareLimit,
    mintedShares: 0, // общее кол-во заминченных в группе
    tiers: {}, // словарь tierId -> { shareLimit, mintedShares, ... }
    operators: {}, // словарь operatorId -> { vaults: { vaultId -> { mintedShares, tierId } } }
  };
  console.log(chalk.green(`Added group: ${groupId} (shareLimit=${shareLimit})`));
}

/**
 * Добавить или обновить Tier в группе.
 *
 * @param {string} groupId
 * @param {string|number} tierId
 * @param {number} shareLimit
 * @param {number} reserveRatio
 * @param {number} reserveRatioThreshold
 */
function addOrUpdateTier(groupId, tierId, shareLimit, reserveRatio, reserveRatioThreshold) {
  const group = operatorGrid.groups[groupId];
  if (!group) {
    throw new Error(`Group ${groupId} does not exist`);
  }

  const tier = group.tiers[tierId] || {};
  tier.shareLimit = shareLimit;
  tier.reserveRatio = reserveRatio;
  tier.reserveRatioThreshold = reserveRatioThreshold;
  // Если раньше не существовало, инициализируем mintedShares = 0
  tier.mintedShares = tier.mintedShares || 0;
  group.tiers[tierId] = tier;

  console.log(
    chalk.green(
      `Tier ${tierId} in group ${groupId}: shareLimit=${shareLimit}, reserveRatio=${reserveRatio}, threshold=${reserveRatioThreshold}`,
    ),
  );
}

/**
 * Добавить оператора (NodeOperator) в группу.
 * У оператора может быть несколько vault'ов.
 *
 * @param {string} groupId
 * @param {string} operatorId
 */
function addOperator(groupId, operatorId) {
  const group = operatorGrid.groups[groupId];
  if (!group) {
    throw new Error(`Group ${groupId} does not exist`);
  }
  if (group.operators[operatorId]) {
    throw new Error(`Operator ${operatorId} already exists in group ${groupId}`);
  }

  group.operators[operatorId] = {
    vaults: {}, // vaultId -> { mintedShares, tierId }
  };

  console.log(chalk.green(`Added operator ${operatorId} in group ${groupId}`));
}

/**
 * Добавляет новый Vault у конкретного оператора.
 * - Чтобы определить, под какой Tier попасть, мы берём текущее число волтов и выбираем
 *   следующий tier в порядке добавления (round-robin) или по индексу.
 *
 * @param {string} groupId
 * @param {string} operatorId
 * @param {string} vaultId
 */
function addVault(groupId, operatorId, vaultId) {
  const group = operatorGrid.groups[groupId];
  if (!group) {
    throw new Error(`Group ${groupId} does not exist`);
  }
  const operator = group.operators[operatorId];
  if (!operator) {
    throw new Error(`Operator ${operatorId} does not exist in group ${groupId}`);
  }

  if (operator.vaults[vaultId]) {
    throw new Error(`Vault ${vaultId} already exists in operator ${operatorId}`);
  }

  // Получим список tier'ов (ключи) из группы
  const tierIds = Object.keys(group.tiers);
  if (tierIds.length === 0) {
    throw new Error(`Group ${groupId} has no tiers. Cannot add a vault.`);
  }

  // Определим, сколько уже волтов у оператора
  const currentVaultCount = Object.keys(operator.vaults).length;
  // Найдём index для тира (например, round-robin)
  const nextTierIndex = currentVaultCount % tierIds.length;
  const assignedTierId = tierIds[nextTierIndex];

  // Создаём новый vault
  operator.vaults[vaultId] = {
    mintedShares: 0,
    tierId: assignedTierId,
  };

  console.log(
    chalk.green(
      `Vault ${vaultId} added to operator ${operatorId} in group ${groupId}, assigned to Tier=${assignedTierId}`,
    ),
  );
}

/**
 * Минтим (добавляем) шары в конкретный vault оператора,
 * учитывая лимит группы и лимит соответствующего Tier.
 *
 * @param {string} groupId
 * @param {string} operatorId
 * @param {string} vaultId
 * @param {number} amount - сколько шаров заминтить
 */
function mintShares(groupId, operatorId, vaultId, amount) {
  const group = operatorGrid.groups[groupId];
  if (!group) {
    throw new Error(`Group ${groupId} does not exist`);
  }
  const operator = group.operators[operatorId];
  if (!operator) {
    throw new Error(`Operator ${operatorId} does not exist in group ${groupId}`);
  }
  const vault = operator.vaults[vaultId];
  if (!vault) {
    throw new Error(`Vault ${vaultId} does not exist under operator ${operatorId}`);
  }

  // Проверка лимита группы
  if (group.mintedShares + amount > group.shareLimit) {
    throw new Error(
      chalk.red(`Group limit exceeded for ${groupId}. minted=${group.mintedShares}, limit=${group.shareLimit}`),
    );
  }

  // Проверка лимита тира
  const tierData = group.tiers[vault.tierId];
  if (!tierData) {
    throw new Error(`Tier ${vault.tierId} not found in group ${groupId}`);
  }
  if (tierData.mintedShares + amount > tierData.shareLimit) {
    throw new Error(
      chalk.red(
        `Tier limit exceeded for tier=${vault.tierId}. minted=${tierData.mintedShares}, limit=${tierData.shareLimit}`,
      ),
    );
  }

  // Всё ок: обновляем mintedShares
  group.mintedShares += amount;
  tierData.mintedShares += amount;
  vault.mintedShares += amount;

  console.log(
    chalk.cyanBright(
      `mintShares: +${amount} to vault ${vaultId} (tier=${vault.tierId}) of operator ${operatorId} in group ${groupId}`,
    ),
  );
}

/**
 * Сжигаем (burn) шары в vault. Уменьшаем mintedShares на всех уровнях.
 */
function burnShares(groupId, operatorId, vaultId, amount) {
  const group = operatorGrid.groups[groupId];
  if (!group) {
    throw new Error(`Group ${groupId} does not exist`);
  }
  const operator = group.operators[operatorId];
  if (!operator) {
    throw new Error(`Operator ${operatorId} does not exist in group ${groupId}`);
  }
  const vault = operator.vaults[vaultId];
  if (!vault) {
    throw new Error(`Vault ${vaultId} does not exist under operator ${operatorId}`);
  }

  if (vault.mintedShares < amount) {
    throw new Error(
      chalk.red(`Not enough shares in vault ${vaultId} to burn. have=${vault.mintedShares}, want=${amount}`),
    );
  }

  // Проверяем, что на тирах/группе тоже хватит "заминченных" (в теории, конечно, хватит, если vault ок)
  const tierData = group.tiers[vault.tierId];
  // Уменьшаем
  vault.mintedShares -= amount;
  tierData.mintedShares -= amount;
  group.mintedShares -= amount;

  console.log(
    chalk.cyanBright(
      `burnShares: -${amount} from vault ${vaultId} (tier=${vault.tierId}) of operator ${operatorId} in group ${groupId}`,
    ),
  );
}

/********************************
 *          ВИЗУАЛИЗАЦИЯ
 *******************************/

/** Прогресс-бар с цветом */
function makeProgressBar(current, max, barLength = 20) {
  if (max <= 0) {
    return chalk.gray("[no limit]");
  }
  const ratio = current / max;
  const used = Math.min(Math.floor(ratio * barLength), barLength);
  const unused = barLength - used;

  // Цветовая логика
  let colorFn = chalk.green;
  if (ratio >= 0.8) {
    colorFn = chalk.red;
  } else if (ratio >= 0.5) {
    colorFn = chalk.yellow;
  }
  const barUsed = "█".repeat(used);
  const barUnused = "░".repeat(unused);
  const percent = (ratio * 100).toFixed(1) + "%";

  return `[${colorFn(barUsed)}${chalk.gray(barUnused)}] ${colorFn(percent)} (${current}/${max})`;
}

/**
 * Визуализируем всё дерево: Group -> Tier -> Operators -> Vaults
 */
// eslint-disable-next-line @typescript-eslint/no-shadow
function visualizeOperatorGrid(operatorGrid) {
  console.log(chalk.bold("\n===== OPERATOR GRID STATUS =====\n"));

  const groupIds = Object.keys(operatorGrid.groups);
  if (groupIds.length === 0) {
    console.log(chalk.red("No groups found."));
    return;
  }

  for (const groupId of groupIds) {
    const group = operatorGrid.groups[groupId];
    const groupBar = makeProgressBar(group.mintedShares, group.shareLimit);
    console.log(chalk.bold(`Group: ${groupId}`), groupBar);

    // Выводим все Tier'ы
    const tierIds = Object.keys(group.tiers);
    for (const tierId of tierIds) {
      const tier = group.tiers[tierId];
      const tierBar = makeProgressBar(tier.mintedShares, tier.shareLimit);
      console.log(
        `  ├─ Tier: ${chalk.magenta(tierId)}  ${tierBar} ` +
          chalk.gray(`(reserveRatio=${tier.reserveRatio}, threshold=${tier.reserveRatioThreshold})`),
      );
    }

    // Выводим операторов
    const operatorIds = Object.keys(group.operators);
    if (operatorIds.length === 0) {
      console.log("  └─ (No operators in this group)");
      continue;
    }

    const lastOperatorIndex = operatorIds.length - 1;
    operatorIds.forEach((operatorId, idx) => {
      const prefix = idx === lastOperatorIndex ? "└" : "├";
      console.log(`  ${prefix}─ Operator: ${chalk.blue(operatorId)}`);

      const operatorData = group.operators[operatorId];
      const vaultIds = Object.keys(operatorData.vaults);
      if (vaultIds.length === 0) {
        console.log("      └─ (No vaults)");
        return;
      }

      const lastVaultIndex = vaultIds.length - 1;
      vaultIds.forEach((vaultId, vaultIdx) => {
        const vaultPrefix = vaultIdx === lastVaultIndex ? "└" : "├";
        const vaultData = operatorData.vaults[vaultId];
        const tier = group.tiers[vaultData.tierId];
        const vaultBar = makeProgressBar(vaultData.mintedShares, tier ? tier.shareLimit : 0);
        console.log(
          `      ${vaultPrefix}─ Vault: ${chalk.yellow(vaultId)}, ` + `tier=${vaultData.tierId}, minted=${vaultBar}`,
        );
      });
    });

    console.log();
  }

  console.log(chalk.bold("================================\n"));
}

/********************************
 *          ДЕМО-КОД
 *******************************/

/** Основная демо-функция, показывающая использование */
function mainDemo() {
  try {
    console.log(chalk.yellowBright("==== DEMO START ===="));

    // 1) Создаём 2 группы
    addGroup("Group0", 1_000_000);
    addGroup("Group1", 3_300_000);

    // 2) Добавляем Tier'ы
    addOrUpdateTier("Group0", "Tier1", 50_000, 20, 22);

    addOrUpdateTier("Group1", "Tier1", 50_000, 5, 6);
    addOrUpdateTier("Group1", "Tier2", 50_000, 6, 7);
    addOrUpdateTier("Group1", "Tier3", 100_000, 9, 12);
    addOrUpdateTier("Group1", "Tier4", 200_000, 16, 20);

    // 3) Добавляем операторов
    addOperator("Group0", "operatorA");
    addOperator("Group1", "operatorX");
    addOperator("Group1", "operatorY");

    // 4) Добавляем волты (каждый новый волт попадает в следующий Tier в round-robin порядке)
    addVault("Group0", "operatorA", "vaultA1"); // Первый волт → Tier1 (т.к. в Group0 только 1 Tier)
    addVault("Group1", "operatorX", "vaultX1"); // Первый волт → Tier1
    addVault("Group1", "operatorX", "vaultX2"); // Второй волт → Tier2
    addVault("Group1", "operatorY", "vaultY1"); // Первый волт у operatorY → Tier1
    addVault("Group1", "operatorY", "vaultY2"); // Второй → Tier2
    addVault("Group1", "operatorY", "vaultY3"); // Третий → Tier3

    // 5) Немного заминтим
    mintShares("Group0", "operatorA", "vaultA1", 10_000);
    mintShares("Group1", "operatorX", "vaultX1", 20_000);
    mintShares("Group1", "operatorX", "vaultX2", 5_000);

    // Визуализируем
    visualizeOperatorGrid(operatorGrid);

    // Попробуем динамические обновления
    console.log(chalk.yellowBright("Starting dynamic mint/burn every 2s...\n"));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const intervalId = setInterval(() => {
      console.clear();

      // Случайно выберем группу
      const possibleGroupOperators = [
        ["Group0", "operatorA", ["vaultA1"]],
        ["Group1", "operatorX", ["vaultX1", "vaultX2"]],
        ["Group1", "operatorY", ["vaultY1", "vaultY2", "vaultY3"]],
      ];
      // Выбираем случайно
      const [groupId, operatorId, vaultArr] =
        possibleGroupOperators[Math.floor(Math.random() * possibleGroupOperators.length)];
      const vaultId = vaultArr[Math.floor(Math.random() * vaultArr.length)];
      const amount = Math.floor(Math.random() * 8_000) + 1_000; // 1k..9k

      // 50/50: mint или burn
      if (Math.random() < 0.5) {
        // Mint
        try {
          mintShares(groupId, operatorId, vaultId, amount);
        } catch (err) {
          console.log(chalk.red("Mint error:", err.message));
        }
      } else {
        // Burn
        try {
          burnShares(groupId, operatorId, vaultId, amount);
        } catch (err) {
          console.log(chalk.red("Burn error:", err.message));
        }
      }

      visualizeOperatorGrid(operatorGrid);
    }, 100);

    // Остановим через 20 секунд
    // setTimeout(() => {
    //   clearInterval(intervalId);
    //   console.log(chalk.yellowBright("\n==== DEMO END ====\n"));
    //   visualizeOperatorGrid(operatorGrid);
    //   process.exit(0);
    // }, 20_000);
  } catch (err) {
    console.error(chalk.red("Error in mainDemo:"), err);
  }
}

// Запускаем демо
mainDemo();
