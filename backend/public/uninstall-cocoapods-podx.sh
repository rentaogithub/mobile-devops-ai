#!/bin/sh

set -eu

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"
export LC_CTYPE="en_US.UTF-8"
export RUBYOPT="${RUBYOPT:-} -EUTF-8:UTF-8"

POD_BIN="$(command -v pod || true)"

if [ -z "$POD_BIN" ]; then
  echo "未找到 pod 命令，请先确认 CocoaPods 是否已安装。" >&2
  exit 1
fi

detect_ruby_bin() {
  if [ -n "${COCOAPODS_PODX_RUBY_BIN:-}" ]; then
    printf '%s\n' "$COCOAPODS_PODX_RUBY_BIN"
    return 0
  fi

  if [ -f "$POD_BIN" ]; then
    pod_shebang="$(sed -n '1s/^#!//p' "$POD_BIN")"
    case "$pod_shebang" in
      */ruby)
        if [ -x "$pod_shebang" ]; then
          printf '%s\n' "$pod_shebang"
          return 0
        fi
        ;;
    esac
  fi

  command -v ruby
}

RUBY_BIN="$(detect_ruby_bin)"
GEM_BIN="${COCOAPODS_PODX_GEM_BIN:-$(dirname "$RUBY_BIN")/gem}"
if [ ! -x "$GEM_BIN" ]; then
  GEM_BIN="$(command -v gem)"
fi

COCOAPODS_GEM_HOME="${COCOAPODS_GEM_HOME:-$("$RUBY_BIN" -e '
pod_bin = ARGV[0]

paths = [pod_bin]
begin
  paths << File.realpath(pod_bin)
rescue StandardError
end

paths.uniq.each do |path|
  next unless File.file?(path)

  content = File.read(path)
  match = content.match(/GEM_HOME="([^"]+)"/)
  if match
    puts match[1]
    exit
  end
end

require "rubygems"
spec = Gem::Specification.find_all_by_name("cocoapods").max_by(&:version)
abort("无法从 #{pod_bin} 探测 CocoaPods GEM_HOME") unless spec
puts spec.base_dir
' "$POD_BIN")}"

GEM_SPEC_CACHE_DIR="${GEM_SPEC_CACHE:-$COCOAPODS_GEM_HOME/specs}"
mkdir -p "$GEM_SPEC_CACHE_DIR"

echo "Uninstalling cocoapods-podx from $COCOAPODS_GEM_HOME..."

for gem_name in cocoapods-podx cocoapods-overlay; do
  if GEM_HOME="$COCOAPODS_GEM_HOME" GEM_PATH="$COCOAPODS_GEM_HOME" GEM_SPEC_CACHE="$GEM_SPEC_CACHE_DIR" "$GEM_BIN" list -i "$gem_name" >/dev/null 2>&1; then
    GEM_HOME="$COCOAPODS_GEM_HOME" \
    GEM_PATH="$COCOAPODS_GEM_HOME" \
    GEM_SPEC_CACHE="$GEM_SPEC_CACHE_DIR" \
    "$GEM_BIN" uninstall "$gem_name" --all --executables --force --ignore-dependencies
  else
    echo "$gem_name [not installed]"
  fi
done

POD_DIR="$(dirname "$POD_BIN")"
for name in podx mgit pox; do
  shim="$POD_DIR/$name"
  if [ -f "$shim" ]; then
    rm -f "$shim"
    echo "$name [removed] $shim"
  fi
done

echo "cocoapods-podx [uninstalled]"
