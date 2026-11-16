// Kit Gallery has no backend: bb requires a server entry, so this one only
// logs that the dev-only gallery is loaded.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function kitGallery(bb: BbPluginApi) {
  bb.log.info("kit gallery loaded (dev only)");
}
