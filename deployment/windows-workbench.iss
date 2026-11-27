#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef WorkbenchVersion
  #error WorkbenchVersion is required
#endif

[Setup]
AppId={{46B2CD42-EFDD-4385-8E79-C4C7B20A758F}
AppName=投研工作台
AppVersion={#WorkbenchVersion}
DefaultDirName={localappdata}\Programs\LLMResearchWorkbench
DefaultGroupName=投研工作台
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
CloseApplications=no
SetupMutex=LLMResearchWorkbench-Setup
Compression=lzma2/fast
SolidCompression=yes
OutputBaseFilename=llm-research-workbench-windows-x64-v{#WorkbenchVersion}

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\LLMResearchWorkbench"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletevalue uninsdeletekeyifempty

[Icons]
Name: "{userdesktop}\投研工作台"; Filename: "{app}\runtime\python\pythonw.exe"; Parameters: "-B ""{app}\scripts\desktop_workbench.py"" open"; WorkingDir: "{app}"
Name: "{group}\投研工作台"; Filename: "{app}\runtime\python\pythonw.exe"; Parameters: "-B ""{app}\scripts\desktop_workbench.py"" open"; WorkingDir: "{app}"
Name: "{group}\停止本地工作台"; Filename: "{app}\runtime\python\pythonw.exe"; Parameters: "-B ""{app}\scripts\desktop_workbench.py"" stop"; WorkingDir: "{app}"
Name: "{group}\开阳本地 Skill"; Filename: "{win}\explorer.exe"; Parameters: "/select,""{app}\llm-research-workbench-kairos-local.zip"""

[Run]
Filename: "{app}\runtime\python\pythonw.exe"; Parameters: "-B ""{app}\scripts\desktop_workbench.py"" open"; WorkingDir: "{app}"; Flags: nowait skipifsilent

[Messages]
SetupWindowTitle=安装 %1
UninstallAppTitle=卸载 %1
InstallingLabel=正在安装本地投研工作台。

[Code]
function StopWorkbench(): Boolean;
var
  Python, Launcher, AppDir: String;
  ReturnCode: Integer;
begin
  AppDir := ExpandConstant('{app}');
  Python := AppDir + '\runtime\python\python.exe';
  Launcher := AppDir + '\scripts\desktop_workbench.py';
  Result := True;
  if FileExists(Python) and FileExists(Launcher) then
    Result := Exec(Python, '-B "' + Launcher + '" stop', AppDir, SW_HIDE,
      ewWaitUntilTerminated, ReturnCode) and (ReturnCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopWorkbench() then
    Result := '暂时无法停止正在运行的本地工作台。请在开始菜单中停止工作台后重试。';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopWorkbench();
  if not Result then
    MsgBox('暂时无法停止正在运行的本地工作台。', mbError, MB_OK);
end;
