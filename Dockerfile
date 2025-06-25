# syntax=docker/dockerfile:1
# Build an image with core integration tests

ARG NODE_VERSION=lts
FROM node:${NODE_VERSION}-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY . .

RUN corepack enable \
 && corepack prepare "yarn@$(node -p "require('./package.json').packageManager.split('@')[1]")" --activate

# Use bind mounts for yarn.lock and package.json only during dependency resolution
# Use a cache mount to speed up repeated dependency installs
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=yarn.lock,target=yarn.lock \
    yarn install --immutable

RUN yarn compile

CMD ["yarn", "test:integration"]
