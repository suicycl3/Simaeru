@echo off
rem ============================================================
rem  Simaeru 起動用
rem    Simaeru.bat        … 通常起動（ビルド済みのものを使う）
rem    Simaeru.bat build  … 作り直してから起動（ソースを変えたとき）
rem    Simaeru.bat dev    … 開発モード（HMR付き。コンソールは開いたまま）
rem  アプリ側で多重起動を禁止しているので、二重に押しても増えません。
rem ============================================================
setlocal
cd /d "%~dp0"

set MODE=%~1

if /i "%MODE%"=="dev" goto dev

rem ビルド成果物が無い、または build 指定なら作り直す
if /i "%MODE%"=="build" goto build
if not exist "out\main\index.js" goto build
goto run

:build
echo ビルドしています...
call npm run build
if errorlevel 1 (
  echo.
  echo ビルドに失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)
goto run

:run
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron が見つかりません。先に npm install を実行してください。
  pause
  exit /b 1
)
rem start で切り離して起動するので、このウィンドウはすぐ閉じる
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:dev
echo 開発モードで起動します。終了するにはこのウィンドウで Ctrl+C を押してください。
call npm run dev
exit /b %errorlevel%
