#!/bin/sh

# Validate args
path="$1"
if [ -z "$path" ]; then
  echo "Must supply path argument"
  exit 1
fi

rm -r $path
