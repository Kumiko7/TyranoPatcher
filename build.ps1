# Builds build\TyranoPatcher.exe (needs the .NET SDK; the exe itself only needs .NET Framework 4.8,
# which ships with Windows 10 1903+ and Windows 11).
$ErrorActionPreference = 'Stop'
dotnet build "$PSScriptRoot\src\TyranoPatcher.csproj" -c Release -o "$PSScriptRoot\build"
