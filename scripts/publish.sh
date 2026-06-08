#!/bin/bash

# Script to publish agent-skill-doctor to npm
# Usage: ./scripts/publish.sh [version]

set -e

# Check if version is provided
if [ -z "$1" ]; then
  echo "Usage: ./scripts/publish.sh <version>"
  echo "Example: ./scripts/publish.sh 0.1.0"
  exit 1
fi

VERSION=$1

echo "Preparing to publish agent-skill-doctor v${VERSION}"

# Run tests
echo "Running tests..."
npm test

# Update version in package.json
echo "Updating version to ${VERSION}..."
npm version ${VERSION} --no-git-tag-version

# Create git tag
echo "Creating git tag v${VERSION}..."
git add package.json package-lock.json
git commit -m "chore: bump version to ${VERSION}"
git tag -a "v${VERSION}" -m "Release v${VERSION}"

# Publish to npm
echo "Publishing to npm..."
npm publish

echo "Successfully published agent-skill-doctor v${VERSION}"
echo "Don't forget to push the tag: git push origin v${VERSION}"
