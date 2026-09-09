@ECHO off
@REM pnpm 10 can lose its .bin PATH entry when Windows inherits both PATH and Path.
node "%~dp0node_modules\typescript\bin\tsc" %*
