Option Explicit
Dim shell, fso, root, command, background
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
background = ""
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--background" Then background = " -Background"
End If
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & root & "\Start-Board.ps1" & Chr(34) & background
shell.Run command, 0, False
