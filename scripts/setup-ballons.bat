@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

set "BT_DIR=C:\Proyectos\BallonsTranslator-Pro"
set "VENV_DIR=%BT_DIR%\.venv"

echo ============================================
echo  BallonsTranslator-Pro - Setup
echo ============================================

if not exist "%BT_DIR%\launch.py" (
  echo [ERROR] No se encontro BallonsTranslator-Pro en %BT_DIR%
  echo Clonalo primero: git clone --depth 1 https://github.com/thomaswantstobeaskeleton/BallonsTranslator-Pro.git "%BT_DIR%"
  exit /b 1
)

rem ---- Buscar Python 3.10-3.13 (torch no soporta 3.14) ----
set "PY_CMD="
for %%V in (3.13 3.12 3.11 3.10) do (
  if not defined PY_CMD (
    py -%%V -c "import sys" >nul 2>&1 && set "PY_CMD=py -%%V"
  )
)

if defined PY_CMD (
  echo [1/5] Python encontrado: !PY_CMD!
  goto :create_venv
)

rem ---- Sin Python compatible: instalar 3.12 con winget ----
where winget >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No hay Python 3.10-3.13 instalado ni winget disponible.
  echo Instala Python 3.12 desde https://www.python.org/downloads/ y vuelve a ejecutar.
  exit /b 1
)

echo [1/5] Instalando Python 3.12 con winget (puede pedir confirmacion)...
winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
  echo [ERROR] winget no pudo instalar Python 3.12.
  exit /b 1
)

rem py launcher tarda en refrescarse tras instalarse; reintentar con rutas tipicas
set "PY_CMD=py -3.12"
py -3.12 -c "import sys" >nul 2>&1
if errorlevel 1 (
  for %%P in ("%LOCALAPPDATA%\Programs\Python\Python312\python.exe" "C:\Program Files\Python312\python.exe") do (
    if exist %%P set "PY_CMD=%%~P"
  )
)
if not defined PY_CMD (
  echo [ERROR] No se encontro Python 3.12 tras instalarlo. Reabre la terminal y vuelve a ejecutar.
  exit /b 1
)
echo [1/5] Python instalado: !PY_CMD!

:create_venv
rem ---- Crear virtualenv ----
if exist "%VENV_DIR%\Scripts\python.exe" (
  echo [2/5] Virtualenv ya existe: %VENV_DIR%
  goto :install_deps
)

echo [2/5] Creando virtualenv en %VENV_DIR% ...
!PY_CMD! -m venv "%VENV_DIR%"
if errorlevel 1 (
  echo [ERROR] No se pudo crear el virtualenv.
  exit /b 1
)

:install_deps
set "VPY=%VENV_DIR%\Scripts\python.exe"

echo [3/5] Actualizando pip...
"%VPY%" -m pip install --upgrade pip

echo [4/5] Instalando PyTorch (CPU - esta maquina no tiene GPU NVIDIA)...
"%VPY%" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 (
  echo [ERROR] No se pudo instalar PyTorch.
  exit /b 1
)

echo [5/5] Instalando dependencias de BallonsTranslator-Pro...
"%VPY%" -m pip install -r "%BT_DIR%\requirements.txt"
if errorlevel 1 (
  echo [ERROR] No se pudieron instalar las dependencias.
  exit /b 1
)

echo.
echo ============================================
echo  Setup completado.
echo  Python: %VPY%
echo ============================================
exit /b 0
