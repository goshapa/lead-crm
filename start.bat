@echo off
cd /d "%~dp0"
pip install -q -r requirements-local.txt
start "" http://127.0.0.1:5000
python app.py
