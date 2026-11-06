import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildWslTaskArguments,
  buildWslTaskXml,
  encodeTaskXmlUtf16,
  resolveWslTaskName,
} from "./wsl-task-xml.js";

const spec = {
  taskName: "Bitterbot Gateway (WSL Ubuntu)",
  description: "Bitterbot Gateway (v1.11.0): starts the WSL gateway supervisor at logon",
  windowsUser: "VICTOR-PC\\vicmg",
  distro: "Ubuntu",
  linuxUser: "vicmg",
  launcher: ["/home/vicmg/.bitterbot/app/current/bin/bitterbot"],
};

describe("WSL logon task XML", () => {
  it("matches the expected task definition", () => {
    const expected = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "  <RegistrationInfo>",
      "    <Description>Bitterbot Gateway (v1.11.0): starts the WSL gateway supervisor at logon</Description>",
      "    <URI>\\Bitterbot Gateway (WSL Ubuntu)</URI>",
      "  </RegistrationInfo>",
      "  <Triggers>",
      "    <LogonTrigger>",
      "      <Enabled>true</Enabled>",
      "      <UserId>VICTOR-PC\\vicmg</UserId>",
      "    </LogonTrigger>",
      "  </Triggers>",
      "  <Principals>",
      '    <Principal id="Author">',
      "      <UserId>VICTOR-PC\\vicmg</UserId>",
      "      <LogonType>InteractiveToken</LogonType>",
      "      <RunLevel>LeastPrivilege</RunLevel>",
      "    </Principal>",
      "  </Principals>",
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "    <AllowHardTerminate>true</AllowHardTerminate>",
      "    <StartWhenAvailable>true</StartWhenAvailable>",
      "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
      "    <IdleSettings>",
      "      <StopOnIdleEnd>false</StopOnIdleEnd>",
      "      <RestartOnIdle>false</RestartOnIdle>",
      "    </IdleSettings>",
      "    <AllowStartOnDemand>true</AllowStartOnDemand>",
      "    <Enabled>true</Enabled>",
      "    <Hidden>false</Hidden>",
      "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
      "    <WakeToRun>false</WakeToRun>",
      "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "    <Priority>7</Priority>",
      "    <RestartOnFailure>",
      "      <Interval>PT1M</Interval>",
      "      <Count>3</Count>",
      "    </RestartOnFailure>",
      "  </Settings>",
      '  <Actions Context="Author">',
      "    <Exec>",
      "      <Command>C:\\Windows\\System32\\wsl.exe</Command>",
      "      <Arguments>-d Ubuntu -u vicmg -- /home/vicmg/.bitterbot/app/current/bin/bitterbot gateway supervise</Arguments>",
      "    </Exec>",
      "  </Actions>",
      "</Task>",
      "",
    ].join("\r\n");
    expect(buildWslTaskXml(spec)).toBe(expected);
  });

  it("disables the 72 hour limit, ignores new instances and triggers at the user's logon", () => {
    const xml = buildWslTaskXml(spec);
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toMatch(
      /<LogonTrigger>[\s\S]*<UserId>VICTOR-PC\\vicmg<\/UserId>[\s\S]*<\/LogonTrigger>/,
    );
  });

  it("quotes launcher parts with spaces and escapes XML in the arguments", () => {
    const args = buildWslTaskArguments({
      distro: "Ubuntu 24.04",
      linuxUser: "vicmg",
      launcher: ["/usr/bin/node", "/opt/my bitterbot/dist/entry.js"],
    });
    expect(args).toBe(
      '-d "Ubuntu 24.04" -u vicmg -- /usr/bin/node "/opt/my bitterbot/dist/entry.js" gateway supervise',
    );
    const xml = buildWslTaskXml({ ...spec, windowsUser: "A&B\\user", launcher: ["/x/y z"] });
    expect(xml).toContain("<UserId>A&amp;B\\user</UserId>");
    expect(xml).toContain(
      "<Arguments>-d Ubuntu -u vicmg -- &quot;/x/y z&quot; gateway supervise</Arguments>",
    );
  });

  it("encodes as UTF-16 LE with a BOM", () => {
    const buf = encodeTaskXmlUtf16("<a/>");
    expect([...buf.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect([...buf.subarray(2, 6)]).toEqual([0x3c, 0x00, 0x61, 0x00]);
    expect(buf.subarray(2).toString("utf16le")).toBe("<a/>");
  });

  it.skipIf(process.platform !== "win32")(
    "passes Windows Task Scheduler validation without registering a task",
    () => {
      // TASK_VALIDATE_ONLY (1) checks the real Windows schema without creating
      // or starting a task. A string snapshot alone previously blessed a typo.
      const script = `
$ErrorActionPreference = 'Stop'
$xml = [Console]::In.ReadToEnd()
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$xml = $xml.Replace('BITTERBOT_TEST_USER', [System.Security.SecurityElement]::Escape($user))
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
[void]$folder.RegisterTask('Bitterbot XML validation', $xml, 1, $null, $null, 3, $null)
Write-Output 'valid'
`;
      const validate = (xml: string) =>
        execFileSync(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { input: xml, encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: "pipe" },
        ).trim();
      const xml = buildWslTaskXml({ ...spec, windowsUser: "BITTERBOT_TEST_USER" });
      expect(validate(xml)).toBe("valid");
      expect(() =>
        validate(xml.replaceAll("AllowHardTerminate", "AllowHardTerminatingTask")),
      ).toThrow();
    },
    35_000,
  );

  it("names the task after the distro and the profile", () => {
    expect(resolveWslTaskName("Ubuntu")).toBe("Bitterbot Gateway (WSL Ubuntu)");
    expect(resolveWslTaskName("Ubuntu", "default")).toBe("Bitterbot Gateway (WSL Ubuntu)");
    expect(resolveWslTaskName("Debian", "rescue")).toBe("Bitterbot Gateway (WSL Debian) (rescue)");
  });
});
