if [ ! -f .env ]; then
  echo ".env file not found!"
  exit 1
fi

set -a
source .env
set +a

echo "Running the Person B"

ts-node bin/personB.ts
