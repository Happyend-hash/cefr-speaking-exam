@echo off
REM ---------------------------------------------------------------
REM  Commits the 20 mocks + the grading fixes and pushes to GitHub.
REM  Just double-click this file. Close the window when it says done.
REM ---------------------------------------------------------------
cd /d "%~dp0"

echo.
echo  Project folder: %CD%
echo.

echo  [1/3] Staging changes...
git add -A || goto :failed

echo  [2/3] Committing...
git commit ^
 -m "Add the 20 mock tests; transcribe Part 3 arguments; fix speaking grading" ^
 -m "Content: content/mocks.json plus the Part 1.2 pictures, imported by scripts/importMocks.js. Every Part 3 FOR/AGAINST table is now text (pros/cons) rather than a screenshot, so students read it as text and the evaluator receives it. Part 2 is one turn holding all three questions: 60s prep, 120s answer." ^
 -m "Grading: submit looked answers up in exam.tasks, which is always empty for a section-based speaking test, so every speaking mock graded zero questions. It now flattens the sections and falls back to tasks for writing. The evaluator also receives the exam part, the instructions shown, the Part 3 statement and its arguments, plus a per-part brief, so a correct 30-second Part 1.1 answer is not marked down for being short." ^
 -m "Presentation: .question is pre-line so Part 2's three questions render one per line. Part 1.2 pictures use object-fit contain, not cover, which was cropping away the differences students have to spot." ^
 -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" ^
 -m "Claude-Session: https://claude.ai/code/session_01LgKXYQSxMY9AyY5uyuhSbh"

if errorlevel 1 (
  echo.
  echo  Nothing new to commit - carrying on to the push anyway.
  echo.
)

echo  [3/3] Pushing to GitHub...
git push || goto :failed

echo.
echo  ================================================
echo   DONE. Now tell Claude "pushed" in the chat.
echo  ================================================
echo.
pause
exit /b 0

:failed
echo.
echo  ================================================
echo   SOMETHING FAILED - copy the red text above
echo   into the chat and Claude will sort it out.
echo  ================================================
echo.
pause
exit /b 1
