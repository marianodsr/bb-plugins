// Helix Bridge frontend entry.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SpikePage } from "./app/spike/SpikePage";

export default definePluginApp((app) => {
  // Dev-only renderer spike; removed once the editor surface is chosen.
  app.slots.navPanel({
    id: "spike",
    title: "Helix spike",
    icon: "Code",
    path: "spike",
    component: SpikePage,
  });
});
