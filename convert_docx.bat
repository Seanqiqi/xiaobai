@echo off
cd /d "%~dp0"
python convert_docx.py 2>nul || py convert_docx.py
