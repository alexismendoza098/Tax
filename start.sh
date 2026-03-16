#!/bin/bash
set -e

cd "$(dirname "$0")/backend"

echo "🔄 Ejecutando migraciones..."
node scripts/migrate.js

echo "✅ Iniciando servidor..."
node server.js
