// Offline candidate only. The paid v8 adapter does not import this module.
// Bound to the pinned native status-bar serializer; never parse customer speech.
export const STATUSBAR_TOOLS = new Set([
  "check_status_bar",
  "set_network_mode_preference",
  "toggle_airplane_mode",
  "reseat_sim_card",
  "toggle_data",
  "toggle_roaming",
  "toggle_data_saver_mode",
  "set_apn_settings",
  "reset_apn_settings",
  "toggle_wifi",
  "toggle_wifi_calling",
  "connect_vpn",
  "disconnect_vpn",
  "grant_app_permission",
  "reboot_device",
]);
const signalTokens = new Map([
  ["📵 No Signal", false],
  ["📶¹ Poor", false],
  ["📶² Fair", false],
  ["📶³ Good", true],
  ["📶⁴ Excellent", true],
]);

export function projectStatusBar(event) {
  if (
    event.seat !== "user" ||
    event.error ||
    !STATUSBAR_TOOLS.has(event.name) ||
    typeof event.content !== "string"
  )
    return [];
  const lines = event.content.split(/\r?\n/);
  const bars = lines.filter((line) => line.startsWith("Status Bar: "));
  if (bars.length !== 1 || lines.at(-1) !== bars[0]) return [];
  const tokens = bars[0].slice("Status Bar: ".length).split(" | ");
  // The fixed leading fields precede Wi-Fi names and other arbitrary display text.
  // Never include an SSID, VPN status, battery or unrelated action output as evidence.
  if (tokens[0] === "✈️ Airplane Mode")
    return [
      {
        fact: "device.strongCellularSignal",
        value: false,
        evidence: ["Status Bar: ✈️ Airplane Mode"],
      },
    ];
  if (!signalTokens.has(tokens[0])) return [];
  const technology = /^(2G|3G|4G|5G)$/.test(tokens[1]) ? tokens[1] : null;
  const data = tokens[technology ? 2 : 1];
  if (!["📱 Data Enabled", "📵 Data Disabled"].includes(data)) return [];
  if (signalTokens.get(tokens[0]) && !technology) return []; // inconsistent/unsupported serializer output
  const facts = [
    {
      fact: "device.strongCellularSignal",
      value: signalTokens.get(tokens[0]) && ["4G", "5G"].includes(technology),
      evidence: [`Status Bar signal: ${tokens[0]}`, `Status Bar network: ${technology ?? "none"}`],
    },
  ];
  // Native "Data Disabled" also means no cellular connection, even if the data
  // switch is ON. It cannot establish device.dataEnabled=false.
  if (data === "📱 Data Enabled" && technology)
    facts.push({
      fact: "device.dataEnabled",
      value: true,
      evidence: ["Status Bar: 📱 Data Enabled"],
    });
  return facts;
}
