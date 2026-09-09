@echo off
node "%~dp0scripts\arki.mjs" --root "%~dp0." --open
if errorlevel 1 pause
