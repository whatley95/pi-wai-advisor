import { afterEach } from "vitest";
import { ScriptedModel } from "./helpers/scripted-model.ts";

// Surface assertion failures thrown inside scripted model steps.
afterEach(() => {
  const failures = [...ScriptedModel.instances].flatMap((m) => m.failures);
  ScriptedModel.instances.clear();
  if (failures.length) throw failures[0];
});
