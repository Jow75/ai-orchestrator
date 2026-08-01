' run-hidden.vbs - launches a command with no console window.
'
' Windows Task Scheduler shows a real, visible console window for any
' console-subsystem executable (node.exe included) run under a LogonType
' that targets the interactive session - there is no task setting that
' suppresses it. WScript.Shell.Run with window style 0 is the standard,
' flash-free way around that: wscript.exe itself has no console, so nothing
' ever appears before the child is told to hide.
'
' Arguments: arg(0) is the working directory, arg(1..N) are the command
' and its parameters (each re-quoted here so paths with spaces survive).
Dim objShell, objArgs, cmd, i

Set objShell = CreateObject("WScript.Shell")
Set objArgs = WScript.Arguments

objShell.CurrentDirectory = objArgs(0)

cmd = ""
For i = 1 To objArgs.Count - 1
    If i > 1 Then cmd = cmd & " "
    cmd = cmd & """" & objArgs(i) & """"
Next

objShell.Run cmd, 0, False
