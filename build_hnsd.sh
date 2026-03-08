#!/bin/bash
# Copyright (c) 2026 Sergei P <spylogsster@gmail.com>
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build hnsd from source.
#
# Cross-platform: Windows (MSYS2/MINGW64), macOS (Homebrew), Linux (apt/dnf).
#
# On Windows, use build_hnsd.cmd to launch this from cmd/PowerShell,
# or run directly from an MSYS2 MINGW64 shell.
#
# What it does:
#   1. Detects platform and installs required packages
#   2. Clones hnsd repository (if not already cloned)
#   3. Builds hnsd binary
#   4. Copies binary (and DLLs on Windows) to ./bin/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENDOR_DIR="$SCRIPT_DIR/vendor"
HNSD_DIR="$VENDOR_DIR/hnsd"
BIN_DIR="$SCRIPT_DIR/bin"
HNSD_REPO="https://github.com/handshake-org/hnsd.git"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Detect platform
detect_platform() {
  case "$(uname -s)" in
    Darwin)
      PLATFORM="macos"
      ;;
    Linux)
      PLATFORM="linux"
      ;;
    MINGW*|MSYS*)
      PLATFORM="windows"
      ;;
    *)
      error "Unsupported platform: $(uname -s)"
      ;;
  esac
  info "Platform: $PLATFORM ($(uname -s))"
}

# Check environment (Windows-specific: must be MSYS2 MINGW64)
check_environment() {
  if [ "$PLATFORM" = "windows" ]; then
    if [ -z "$MSYSTEM" ]; then
      error "Not running in MSYS2 shell. Use build_hnsd.cmd or launch MSYS2 MINGW64 shell."
    fi
    if [ "$MSYSTEM" != "MINGW64" ]; then
      warn "MSYSTEM=$MSYSTEM (expected MINGW64). Build may not produce correct binaries."
    fi
    info "Environment: $MSYSTEM"
  fi
}

# Install required packages
install_packages() {
  info "Installing required packages..."

  case "$PLATFORM" in
    windows)
      pacman -S --noconfirm --needed \
        base-devel \
        mingw-w64-x86_64-toolchain \
        mingw-w64-x86_64-unbound \
        autoconf \
        automake \
        libtool \
        git
      ;;
    macos)
      if ! command -v brew &>/dev/null; then
        error "Homebrew not found. Install from https://brew.sh"
      fi
      brew install autoconf automake libtool unbound openssl git || true
      ;;
    linux)
      if command -v apt-get &>/dev/null; then
        sudo apt-get update
        sudo apt-get install -y build-essential autoconf automake libtool \
          libunbound-dev libssl-dev git
      elif command -v dnf &>/dev/null; then
        sudo dnf install -y gcc make autoconf automake libtool \
          unbound-devel openssl-devel git
      elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm --needed base-devel autoconf automake \
          libtool unbound openssl git
      else
        error "No supported package manager found (apt, dnf, pacman)."
      fi
      ;;
  esac

  info "Packages installed."
}

# Clone or update hnsd
clone_hnsd() {
  mkdir -p "$VENDOR_DIR"
  if [ -d "$HNSD_DIR/.git" ]; then
    info "hnsd already cloned, updating..."
    cd "$HNSD_DIR"
    git pull --ff-only || warn "Could not update hnsd (working on detached HEAD?)"
  else
    info "Cloning hnsd..."
    git clone "$HNSD_REPO" "$HNSD_DIR"
  fi
  cd "$HNSD_DIR"
  info "hnsd at commit: $(git rev-parse --short HEAD)"
}

# Build hnsd
build_hnsd() {
  cd "$HNSD_DIR"

  if [ ! -f configure ]; then
    info "Running autogen.sh..."
    ./autogen.sh
  fi

  if [ ! -f Makefile ]; then
    info "Running configure..."
    ./configure
  fi

  info "Building hnsd..."
  make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

  if [ ! -f hnsd.exe ] && [ ! -f hnsd ]; then
    error "Build failed: hnsd binary not found"
  fi

  info "Build complete."
}

# Copy binary to bin/
install_binary() {
  mkdir -p "$BIN_DIR"

  if [ "$PLATFORM" = "windows" ]; then
    # Windows: copy .exe and required DLLs
    if [ -f "$HNSD_DIR/hnsd.exe" ]; then
      cp "$HNSD_DIR/hnsd.exe" "$BIN_DIR/hnsd.exe"
    elif [ -f "$HNSD_DIR/hnsd" ]; then
      cp "$HNSD_DIR/hnsd" "$BIN_DIR/hnsd.exe"
    fi

    local hnsd_deps
    hnsd_deps=$(ldd "$BIN_DIR/hnsd.exe" 2>/dev/null | grep mingw64 | awk '{print $3}' || true)
    if [ -n "$hnsd_deps" ]; then
      info "Copying required DLLs..."
      for dll in $hnsd_deps; do
        cp "$dll" "$BIN_DIR/" 2>/dev/null || true
      done
    fi

    info "Installed: $BIN_DIR/hnsd.exe"
    "$BIN_DIR/hnsd.exe" --help 2>&1 | head -5 || true
  else
    # macOS/Linux: copy binary
    cp "$HNSD_DIR/hnsd" "$BIN_DIR/hnsd"
    chmod +x "$BIN_DIR/hnsd"
    info "Installed: $BIN_DIR/hnsd"
    "$BIN_DIR/hnsd" --help 2>&1 | head -5 || true
  fi
}

# Main
main() {
  info "=== hnsd Build Script ==="
  detect_platform
  check_environment
  install_packages
  clone_hnsd
  build_hnsd
  install_binary
  info "=== Done ==="
  info "Binary: $BIN_DIR/$([ "$PLATFORM" = "windows" ] && echo hnsd.exe || echo hnsd)"
  info "Run: node check_hns.js sync"
}

main "$@"
