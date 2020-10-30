#!/bin/sh

IPFS_DIR=/data/ipfs
CACHE_DIR=/export
mkdir -p $CACHE_DIR

if [ ! -d $IPFS_DIR ] || [ ! "$(ls -A $IPFS_DIR)" ]; then
  echo "Tuning ipfs..."
  # /usr/local/bin/start_ipfs init
  /usr/local/bin/start_ipfs bootstrap rm --all
  chmod -R ugo+wrX $IPFS_DIR
  if [ ! "$(ls -A $CACHE_DIR)" ]; then
    cd /tmp
    wget -q https://registry.npmjs.org/@aragon/aragen/-/$ARAGEN_PKG
    echo "Initializing ipfs data from Aragen snapshot"
    tar -zxf $ARAGEN_PKG -C $CACHE_DIR --strip 2 package/ipfs-cache/@aragon
    echo "Adding default Aragon assets ($ARAGEN_PKG)..."
    HASH=$(/usr/local/bin/start_ipfs add -r -Q $CACHE_DIR/@aragon | tail -1)
    echo "Asset hash: $HASH"
    rm -f $ARAGEN_PKG
    cd -
  fi
fi

chmod -R ugo+wrX $IPFS_DIR

echo "Starting ipfs..."
/usr/local/bin/start_ipfs daemon --migrate=true --enable-gc
