// The keys the plugin's hints name. Inside Helix everything is `space` and a
// key: `space e` for the files, `space u` and a letter for the rest. They are
// the suggested bindings (README; the fork's config/keys-bb.example.toml), set
// in the owner's own Helix config, where each one runs `:bb-emit <action>` or
// a `:bb-` command. bb's own shortcuts are left alone: the palette lists every
// command and bb's Keyboard settings can bind any of them.

/** A hint's combo for a key under the leader, e.g. `u("shift+c")` is `space u C`. */
export const u = (key: string) => `space+u+${key}`;

/** For the `?` sheet: what the suggested bindings do from inside Helix. */
export const HELIX_KEYS = [
  { keys: ["space+e"], description: "Files" },
  { keys: [u("r")], description: "Changes" },
  { keys: [u("m")], description: "Comments" },
  { keys: [u("u")], description: "Show or hide the rail" },
  { keys: [u("f")], description: "Next changed file" },
  { keys: [u("shift+f")], description: "Previous changed file" },
  { keys: [u("v")], description: "Mark viewed and go to the next" },
  { keys: [u("d")], description: "Inline diff on or off" },
  { keys: [u("c")], description: "Comment on the selection" },
  { keys: [u("shift+c")], description: "Send to thread" },
  { keys: [u("s")], description: "Selection to the composer" },
  { keys: [u("t")], description: "The chat (Escape comes back)" },
].map((row) => ({ ...row, group: "In Helix" }));
