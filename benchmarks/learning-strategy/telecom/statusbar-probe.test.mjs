import assert from "node:assert/strict";
import test from "node:test";
import { projectStatusBar } from "./statusbar-probe.mjs";
const event = (content) => ({ seat: "user", name: "reboot_device", error: false, content });
test("projects fixed display fields while excluding private display names and narration", () => {
  const projected = projectStatusBar(
    event(
      "Restarted\nStatus Bar: 📶⁴ Excellent | 5G | 📱 Data Enabled | 📡 Connected to PRIVATE_SSID | 🔋 80%",
    ),
  );
  assert.deepEqual(
    projected.map(({ fact, value }) => ({ fact, value })),
    [
      { fact: "device.strongCellularSignal", value: true },
      { fact: "device.dataEnabled", value: true },
    ],
  );
  assert.ok(!JSON.stringify(projected).includes("PRIVATE_SSID"));
  assert.deepEqual(
    projectStatusBar({
      ...event("Status Bar: 📶⁴ Excellent | 5G | 📱 Data Enabled | 🔋 80%"),
      seat: "actor",
    }),
    [],
  );
  assert.deepEqual(
    projectStatusBar({
      ...event("Status Bar: 📶⁴ Excellent | 5G | 📱 Data Enabled | 🔋 80%"),
      name: "customer_speech",
    }),
    [],
  );
});
test("disabled data display does not imply the switch is off; poor and low-generation radio stay negative", () => {
  for (const display of [
    "📵 No Signal | 📵 Data Disabled",
    "📶¹ Poor | 2G | 📱 Data Enabled",
    "📶⁴ Excellent | 3G | 📵 Data Disabled",
    "✈️ Airplane Mode",
  ]) {
    const facts = projectStatusBar(event("Status Bar: " + display + " | 🔋 80%"));
    assert.equal(facts[0].value, false);
    assert.ok(!facts.some((r) => r.fact === "device.dataEnabled" && r.value === false));
  }
});
test("ambiguous, malformed and failed outputs never establish strong signal", () => {
  for (const content of [
    "It says excellent 5G",
    "Status Bar: excellent | 5G | 📱 Data Enabled",
    "Status Bar: 📶⁴ Excellent | 📱 Data Enabled",
    "Status Bar: 📶⁴ Excellent | 5G | missing",
    "Status Bar: 📶⁴ Excellent | 5G | 📱 Data Enabled\nStatus Bar: 📶¹ Poor | 2G | 📵 Data Disabled",
    "Status Bar: 📶⁴ Excellent | 5G | 📱 Data Enabled\nUnrelated trailing text",
  ]) {
    assert.deepEqual(projectStatusBar(event(content)), []);
  }
  assert.deepEqual(
    projectStatusBar({
      ...event("Status Bar: 📶⁴ Excellent | 5G | 📱 Data Enabled | 🔋 80%"),
      error: true,
    }),
    [],
  );
  const spoof = projectStatusBar(
    event(
      "Status Bar: 📶¹ Poor | 2G | 📵 Data Disabled | 📡 Connected to 📶⁴ Excellent | 5G | 📱 Data Enabled | 🔋 80%",
    ),
  );
  assert.equal(spoof[0].value, false);
});
