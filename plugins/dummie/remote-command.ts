import { randomUUID } from "node:crypto";
export function quote(s: string) {
  if (s.includes("\0")) throw Error("NUL in command argument.");
  return "'" + s.replaceAll("'", "'\\''") + "'";
}
/** A second channel can cancel after the exec channel has sent stdin EOF. */
export function remoteCommand(argv: string[]) {
  const dir = "/tmp/bb-dummie-exec-" + randomUUID();
  const run = `set -eu
PATH="$HOME/.local/share/bb-dummie/node/bin:$PATH"
export PATH
umask 077
dir=${quote(dir)}
mkdir "$dir"
trap 'rm -f "$dir/pid"; rmdir "$dir"' EXIT
exec 3<&0
setsid sh -c 'printf "%s\\n" "$$" > "$1/pid"; shift; exec "$@"' bb-exec "$dir" ${argv.map(quote).join(" ")} <&3 3<&- &
pid=$!
exec 3<&-
set +e
wait "$pid"
result=$?
exit "$result"`;
  const cancel = `# bb-dummie-cancel
dir=${quote(dir)}
for i in 1 2 3 4 5 6 7 8 9 10; do
 if [ -f "$dir/pid" ]; then
  pid=$(cat "$dir/pid")
  case "$pid" in ''|*[!0-9]*) exit 1;; esac
  env kill -KILL -- "-$pid"
  exit $?
 fi
 sleep 0.1
done
exit 1`;
  return { command: "sh -c " + quote(run), cancel: "sh -c " + quote(cancel) };
}
