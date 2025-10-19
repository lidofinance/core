# Deployment Reports

This guide explains how to generate modern, interactive HTML reports for Lido protocol deployments and upgrades.

## Overview

The deployment report generator creates beautiful, interactive HTML reports with:

- **Modern UI Design**: Clean, responsive layout with gradient backgrounds and card-based information display
- **SVG Timeline Visualization**: Visual timeline showing deployment steps with color-coded status indicators
- **Detailed Event Tracking**: Comprehensive tracking of contract deployments, initializations, and transactions
- **Gas Usage Analytics**: Track and display gas consumption for each deployment step
- **Clean Data Presentation**: Well-organized tables and cards for easy data comprehension

## Features

### Visual Timeline

The SVG-based timeline provides a clear visual representation of the deployment process:

- **Color-coded status indicators**:

  - 🟢 Green: Success
  - 🟡 Yellow: Pending/Warning
  - 🔴 Red: Error

- **Progressive gradient line**: Shows the flow of deployment from start to finish

### Summary Cards

Key metrics displayed in interactive cards:

- Network name
- Deployer address
- Total transactions
- Total gas used
- Deployment duration

### Detailed Event Table

Comprehensive table showing:

- Event status badges
- Event names and descriptions
- Timestamps
- Gas usage per transaction
- Transaction hashes (truncated for readability)
- Contract addresses

## Usage

### Generate Example Report

To see the report generator in action with sample data:

```bash
yarn hardhat report:example
```

This creates a sample report at `reports/example-deployment-report.html` with realistic deployment data.

### Generate Report from Deployment State

To generate a report from an actual deployment state file:

```bash
yarn hardhat report:generate --file deployed-mainnet.json
```

Optional parameters:

- `--file`: Path to the deployment state file (default: `deployed-mainnet.json`)
- `--output`: Output path for the HTML report (default: `reports/deployment-report.html`)

Examples:

```bash
# Generate report for Holesky deployment
yarn hardhat report:generate --file deployed-holesky.json --output reports/holesky-report.html

# Generate report for Sepolia deployment
yarn hardhat report:generate --file deployed-sepolia.json --output reports/sepolia-report.html
```

## Programmatic Usage

You can also use the report generator in your own scripts:

```typescript
import { generateReport, ReportData, TimelineEvent } from "lib/report-generator";

// Prepare your deployment data
const events: TimelineEvent[] = [
  {
    id: "1",
    title: "Deploy Contract",
    description: "Main staking contract",
    timestamp: new Date(),
    status: "success",
    gasUsed: "1,234,567",
    txHash: "0x...",
    address: "0x...",
  },
  // ... more events
];

const reportData: ReportData = {
  title: "My Deployment Report",
  subtitle: "Custom deployment on testnet",
  network: "goerli",
  deployer: "0x...",
  events: events,
  summary: {
    totalTransactions: events.length,
    totalGasUsed: "5,000,000",
    duration: "15 minutes",
  },
};

// Generate the report
generateReport(reportData, "reports/my-deployment.html");
```

## Report Structure

The generated HTML report includes:

1. **Header Section**: Title and subtitle
2. **Summary Cards**: Key deployment metrics in a responsive grid
3. **Timeline Visualization**: SVG-based visual timeline of events
4. **Event Details Table**: Comprehensive table with all event information
5. **Footer**: Generation timestamp

## Viewing Reports

After generation, reports can be viewed in any modern web browser. The reports are:

- **Self-contained**: All styles are embedded, no external dependencies
- **Responsive**: Works on desktop, tablet, and mobile devices
- **Print-friendly**: Can be printed or saved as PDF from the browser

To view a report:

```bash
# macOS
open reports/example-deployment-report.html

# Linux
xdg-open reports/example-deployment-report.html

# Windows
start reports/example-deployment-report.html
```

## Customization

The report generator can be extended to include additional information:

- Custom metadata fields
- Additional summary statistics
- Different color schemes
- Extra event properties

Modify `lib/report-generator.ts` to customize the appearance and content of reports.

## Best Practices

1. **Generate reports after each deployment**: Keep a history of all deployments
2. **Archive reports**: Store reports alongside deployment artifacts
3. **Share reports**: Reports are easy to share with team members and auditors
4. **Review before production**: Use reports to review deployment steps before mainnet

## Troubleshooting

### Report not generating

If the report fails to generate, check:

- The deployment state file exists and is valid JSON
- The output directory is writable
- All required fields are present in the state file

### Styles not rendering

Reports are self-contained with embedded styles. If styles don't render:

- Open the HTML file directly in a browser (not through a code editor preview)
- Check browser console for any errors
- Ensure you're using a modern browser (Chrome, Firefox, Safari, Edge)

## Examples

See `reports/example-deployment-report.html` for a complete example with sample data showing all features of the report generator.
