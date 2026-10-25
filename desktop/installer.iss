; Paradox Desktop Agent — per-user installer.
; Built by desktop/build.ps1; no administrator rights are requested.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceExe
  #define SourceExe "dist\ParadoxAgent.exe"
#endif
#ifndef OutputDir
  #define OutputDir "out"
#endif

[Setup]
AppId={{7C4D1E52-6A31-4F0C-9C5B-2B9D6E1A8F44}
AppName=Paradox Desktop Agent
AppVersion={#AppVersion}
AppPublisher=Paradox
DefaultDirName={localappdata}\Paradox\Desktop Agent
DefaultGroupName=Paradox
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=ParadoxSetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\ParadoxAgent.exe
; Signed builds set this in the release pipeline, not here
; SignTool=signtool

[Tasks]
Name: "autostart"; Description: "Start Paradox Desktop Agent when I sign in"; GroupDescription: "Startup:"; Flags: checkedonce
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Paradox Desktop Agent"; Filename: "{app}\ParadoxAgent.exe"
Name: "{autodesktop}\Paradox Desktop Agent"; Filename: "{app}\ParadoxAgent.exe"; Tasks: desktopicon

[Registry]
; Per-user autostart: no elevation, no service
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "ParadoxDesktopAgent"; \
  ValueData: """{app}\ParadoxAgent.exe"" --api {code:GetApiUrl}"; \
  Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\ParadoxAgent.exe"; Parameters: "--api {code:GetApiUrl}"; \
  Description: "Open Paradox Desktop Agent"; Flags: nowait postinstall skipifsilent

[Code]
var
  ApiPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  { The API base URL is baked into the build's shortcut arguments. It is not a
    secret: the device token is obtained through enrollment, never shipped. }
  ApiPage := CreateInputQueryPage(wpSelectTasks,
    'Paradox server', 'Where should this computer connect?',
    'Use the address of the Paradox instance you signed in to.');
  ApiPage.Add('API base URL:', False);
  ApiPage.Values[0] := 'https://app.paradox.example';
end;

function GetApiUrl(Param: String): String;
begin
  Result := ApiPage.Values[0];
end;
