#!/bin/sh

if [ x$REBUILD_INSTEAD == x1 ]; then
    if which pnpm; then
        pnpm build
    elif which yarn; then
        yarn build
    elif which npm; then
        npm build
    else
        echo "no package manager found and no dist/index.js found, exiting"
        exit -1
    fi && \
        exec node dist/index.js "${@}"
else
    if which pnpm; then
        pnpm start "${@}"
    elif which yarn; then
        yarn start "${@}"
    elif which npm; then
        npm start "${@}"
    else
        echo "no package manager found and no dist/index.js found, exiting"
        exit -1
    fi
fi
