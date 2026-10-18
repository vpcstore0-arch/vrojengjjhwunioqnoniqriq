#!/bin/bash
set -e

# Render injeta $PORT. Se não vier, usa 80 (padrão Apache).
PORT="${PORT:-80}"

if [ "$PORT" != "80" ]; then
    sed -i "s/Listen 80/Listen ${PORT}/g" /etc/apache2/ports.conf
    sed -i "s/:80>/:${PORT}>/g" /etc/apache2/sites-available/000-default.conf
fi

exec "$@"
