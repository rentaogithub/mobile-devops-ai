#!/bin/sh

set -eu

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"
export LC_CTYPE="en_US.UTF-8"
export RUBYOPT="${RUBYOPT:-} -EUTF-8:UTF-8"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
NEXUS_ASSET_BASE="${COCOAPODS_PODX_GEM_SOURCE:-${COCOAPODS_OVERLAY_GEM_SOURCE:-http://172.31.4.4:9091/repository/nn_ios/rubygems/cocoapods-podx/}}"
NEXUS_SEARCH_API="${COCOAPODS_PODX_NEXUS_SEARCH_API:-${COCOAPODS_OVERLAY_NEXUS_SEARCH_API:-http://172.31.4.4:9091/service/rest/beta/search/assets?repository=nn_ios}}"
NEXUS_USER="${COCOAPODS_PODX_NEXUS_USER:-${COCOAPODS_OVERLAY_NEXUS_USER:-admin}}"
NEXUS_PASSWORD="${COCOAPODS_PODX_NEXUS_PASSWORD:-${COCOAPODS_OVERLAY_NEXUS_PASSWORD:-admin123}}"
VERSION="${COCOAPODS_PODX_VERSION:-${COCOAPODS_OVERLAY_VERSION:-${1:-}}}"
POD_BIN="$(command -v pod || true)"
PUBLISH_ONLY_MODE=0
LOCAL_INSTALL_MODE="${COCOAPODS_PODX_LOCAL_INSTALL:-0}"
PLUGIN_DIR="$SCRIPT_DIR/cocoapods-podx"
GEMSPEC_PATH="$PLUGIN_DIR/cocoapods-podx.gemspec"

if [ -z "$POD_BIN" ]; then
  PUBLISH_ONLY_MODE=1
fi

if [ "$PUBLISH_ONLY_MODE" = "1" ]; then
  COCOAPODS_GEM_HOME="${COCOAPODS_GEM_HOME:-$(ruby -e 'require "rubygems"; puts Gem.user_dir')}"
else
  COCOAPODS_GEM_HOME="${COCOAPODS_GEM_HOME:-$(ruby -e '
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
fi

GEM_SPEC_CACHE_DIR="${GEM_SPEC_CACHE:-$COCOAPODS_GEM_HOME/specs}"
mkdir -p "$GEM_SPEC_CACHE_DIR"

repair_ffi_extensions() {
  if GEM_HOME="$COCOAPODS_GEM_HOME" GEM_PATH="$COCOAPODS_GEM_HOME" ruby -e 'require "rubygems"; exit Gem::Specification.find_all_by_name("ffi", "= 1.17.0").empty? ? 1 : 0' >/dev/null 2>&1; then
    GEM_HOME="$COCOAPODS_GEM_HOME" \
    GEM_PATH="$COCOAPODS_GEM_HOME" \
    GEM_SPEC_CACHE="$GEM_SPEC_CACHE_DIR" \
    gem pristine ffi --version 1.17.0 --extensions >/dev/null 2>&1 || true
  fi
}

repair_ffi_extensions

generate_build_shims() {
  mkdir -p "$PLUGIN_DIR/bin"
  for name in podx mgit; do
    source_path="$PLUGIN_DIR/lib/cocoapods_podx/shims/$name"
    destination_path="$PLUGIN_DIR/bin/$name"
    if [ ! -f "$source_path" ]; then
      echo "Missing command shim template: $source_path" >&2
      exit 1
    fi
    cp "$source_path" "$destination_path"
    chmod +x "$destination_path"
  done
}

install_command_shims() {
  if [ "$PUBLISH_ONLY_MODE" = "1" ]; then
    pod_dir="${COCOAPODS_PODX_BIN_DIR:-$HOME/.local/bin}"
    mkdir -p "$pod_dir"
    export PATH="$pod_dir:$PATH"
  else
    pod_dir="$(dirname "$POD_BIN")"
  fi

  if [ ! -w "$pod_dir" ]; then
    echo "Warning: unable to write command shims into $pod_dir" >&2
    return
  fi

  write_podx_shim "$pod_dir/podx"
  chmod +x "$pod_dir/podx"
  write_mgit_shim "$pod_dir/mgit"
  chmod +x "$pod_dir/mgit"
  rm -f "$pod_dir/pox"
}

install_generated_shim() {
  destination="$1"
  tmp_path="${destination}.tmp.$$"
  cat > "$tmp_path"
  chmod +x "$tmp_path"
  mv -f "$tmp_path" "$destination"
}

ensure_publish_only_path() {
  [ "$PUBLISH_ONLY_MODE" = "1" ] || return 0

  pod_dir="${COCOAPODS_PODX_BIN_DIR:-$HOME/.local/bin}"
  export_line="export PATH=\"$pod_dir:\$PATH\""

  case ":$PATH:" in
    *":$pod_dir:"*)
      ;;
    *)
      export PATH="$pod_dir:$PATH"
      ;;
  esac

  if [ -n "${COCOAPODS_PODX_SHELL_PROFILE:-}" ]; then
    update_shell_profile "$COCOAPODS_PODX_SHELL_PROFILE" "$export_line" "$pod_dir"
    return
  fi

  profile_paths=""
  for candidate in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
    if [ -f "$candidate" ]; then
      profile_paths="$profile_paths $candidate"
    fi
  done

  if [ -z "$profile_paths" ]; then
    profile_paths="$HOME/.zshrc"
  fi

  for profile_path in $profile_paths; do
    update_shell_profile "$profile_path" "$export_line" "$pod_dir"
  done
}

update_shell_profile() {
  profile_path="$1"
  export_line="$2"
  pod_dir="$3"

  if [ ! -f "$profile_path" ]; then
    printf '%s\n' "$export_line" > "$profile_path"
    echo "PATH [updated] $profile_path"
    return
  fi

  if grep -F "$pod_dir" "$profile_path" >/dev/null 2>&1; then
    return
  fi

  {
    printf '\n'
    printf '# cocoapods-podx publish-only\n'
    printf '%s\n' "$export_line"
  } >> "$profile_path"
  echo "PATH [updated] $profile_path"
}

write_podx_shim() {
  copy_command_shim "podx" "$1"
}

write_mgit_shim() {
  copy_command_shim "mgit" "$1"
}

copy_command_shim() {
  name="$1"
  destination="$2"
  source_path="$SCRIPT_DIR/bin/$name"
  if [ ! -f "$source_path" ]; then
    source_path="$SCRIPT_DIR/cocoapods-podx/bin/$name"
  fi
  if [ ! -f "$source_path" ]; then
    source_path="$SCRIPT_DIR/cocoapods-podx/lib/cocoapods_podx/shims/$name"
  fi
  if [ ! -f "$source_path" ]; then
    source_path="$(GEM_HOME="$COCOAPODS_GEM_HOME" GEM_PATH="$COCOAPODS_GEM_HOME" ruby -e 'require "rubygems"; spec = Gem::Specification.find_by_name("cocoapods-podx"); puts File.join(spec.full_gem_path, "bin", ARGV[0])' "$name" 2>/dev/null || true)"
  fi
  if [ ! -f "$source_path" ]; then
    echo "Missing command shim template: $source_path" >&2
    exit 1
  fi
  if [ "$PUBLISH_ONLY_MODE" = "1" ]; then
    {
      printf '#!/bin/sh\n'
      printf 'export GEM_HOME="%s"\n' "$COCOAPODS_GEM_HOME"
      printf 'export GEM_PATH="%s${GEM_PATH:+:$GEM_PATH}"\n' "$COCOAPODS_GEM_HOME"
      tail -n +2 "$source_path"
    } | install_generated_shim "$destination"
  else
    install_generated_shim "$destination" < "$source_path"
  fi
}

if [ "$LOCAL_INSTALL_MODE" != "1" ] && [ -z "$VERSION" ]; then
  VERSION="$(NEXUS_SEARCH_API="$NEXUS_SEARCH_API" \
    NEXUS_USER="$NEXUS_USER" \
    NEXUS_PASSWORD="$NEXUS_PASSWORD" \
    ruby -e '
require "json"
require "net/http"
require "uri"

api = ENV.fetch("NEXUS_SEARCH_API")
user = ENV["NEXUS_USER"]
password = ENV["NEXUS_PASSWORD"]
versions = []
token = nil

loop do
  uri = URI(api)
  params = URI.decode_www_form(uri.query || "")
  params << ["continuationToken", token] if token && !token.empty?
  uri.query = URI.encode_www_form(params)

  request = Net::HTTP::Get.new(uri)
  request.basic_auth(user, password) if user && !user.empty?

  response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https") do |http|
    http.request(request)
  end

  abort("Nexus 查询失败：HTTP #{response.code}") unless response.is_a?(Net::HTTPSuccess)

  body = JSON.parse(response.body)
  Array(body["items"]).each do |item|
    path = item["path"].to_s
    next unless path.start_with?("rubygems/cocoapods-podx/")

    match = path.match(%r{cocoapods-podx-([0-9]+(?:\.[0-9]+)*)\.gem\z})
    versions << match[1] if match
  end

  token = body["continuationToken"]
  break if token.nil? || token.empty?
end

abort("Nexus 中未找到 cocoapods-podx gem，请通过 COCOAPODS_PODX_VERSION 指定版本。") if versions.empty?
puts versions.max_by { |version| version.split(".").map(&:to_i) }
')"
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cocoapods-podx.XXXXXX")"
GEM_FILE=""

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if [ "$LOCAL_INSTALL_MODE" = "1" ]; then
  if [ ! -f "$GEMSPEC_PATH" ]; then
    echo "Missing gemspec: $GEMSPEC_PATH" >&2
    exit 1
  fi

  VERSION="$(ruby -e "spec = Gem::Specification.load(ARGV[0]); abort('Failed to load gemspec') unless spec; puts spec.version" "$GEMSPEC_PATH")"
  echo "Installing cocoapods-podx $VERSION from local source..."
  echo "Source: $PLUGIN_DIR"
else
  GEM_URL="${NEXUS_ASSET_BASE%/}/cocoapods-podx-$VERSION.gem"
  echo "Installing cocoapods-podx $VERSION from Nexus..."
  echo "Source: $GEM_URL"
fi

if [ "$PUBLISH_ONLY_MODE" = "1" ]; then
  echo "Mode: publish-only (CocoaPods not found)"
  echo "Ruby GEM_HOME: $COCOAPODS_GEM_HOME"
else
  echo "CocoaPods GEM_HOME: $COCOAPODS_GEM_HOME"
fi

if [ "$LOCAL_INSTALL_MODE" = "1" ]; then
  generate_build_shims
  (cd "$PLUGIN_DIR" && gem build cocoapods-podx.gemspec >/dev/null)
  GEM_FILE="$PLUGIN_DIR/cocoapods-podx-$VERSION.gem"
  if [ ! -f "$GEM_FILE" ]; then
    echo "Missing gem file after build: $GEM_FILE" >&2
    exit 1
  fi
else
  GEM_FILE="$TMP_DIR/cocoapods-podx-$VERSION.gem"
  if [ -n "$NEXUS_USER" ]; then
    curl -fL -u "$NEXUS_USER:$NEXUS_PASSWORD" -o "$GEM_FILE" "$GEM_URL"
  else
    curl -fL -o "$GEM_FILE" "$GEM_URL"
  fi
fi

for gem_name in cocoapods-podx cocoapods-overlay; do
  if GEM_HOME="$COCOAPODS_GEM_HOME" GEM_PATH="$COCOAPODS_GEM_HOME" GEM_SPEC_CACHE="$GEM_SPEC_CACHE_DIR" gem list -i "$gem_name" >/dev/null 2>&1; then
    GEM_HOME="$COCOAPODS_GEM_HOME" \
    GEM_PATH="$COCOAPODS_GEM_HOME" \
    GEM_SPEC_CACHE="$GEM_SPEC_CACHE_DIR" \
    gem uninstall "$gem_name" --all --executables --ignore-dependencies >/dev/null 2>&1 || true
  fi
done

GEM_HOME="$COCOAPODS_GEM_HOME" \
GEM_PATH="$COCOAPODS_GEM_HOME" \
GEM_SPEC_CACHE="$GEM_SPEC_CACHE_DIR" \
gem install --local --ignore-dependencies --force --no-document "$GEM_FILE"

install_command_shims
ensure_publish_only_path

echo "cocoapods-podx [installed] $VERSION"
if [ "$PUBLISH_ONLY_MODE" = "1" ]; then
  echo "publish-only [enabled]"
  echo "Note: podx publish and all mgit commands are available without CocoaPods."
  echo "PATH: ${COCOAPODS_PODX_BIN_DIR:-$HOME/.local/bin}"
fi
echo "Verify:"
echo "  podx help"
echo "  mgit help"
