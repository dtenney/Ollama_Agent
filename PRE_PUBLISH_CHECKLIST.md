# Pre-Publish Checklist

Use this checklist before pushing to GitHub and publishing to VS Code Marketplace.

## ✅ Repository Cleanup
- [x] Remove all temporary documentation files
- [x] Remove old VSIX packages
- [x] Enhance .gitignore with comprehensive patterns
- [x] Create CHANGELOG.md
- [x] Verify CONTRIBUTING.md is complete
- [x] Verify README.md is comprehensive

## ✅ Code Quality
- [x] No console.log statements in production code
- [x] No TODO/FIXME comments (except legitimate examples)
- [x] TypeScript builds without errors (`npm run build`)
- [x] All imports are used
- [x] No hardcoded credentials or API keys
- [x] Proper error handling throughout

## 📋 Package.json Verification
- [ ] Verify `version` is correct (currently: 0.2.0)
- [ ] Verify `displayName` is correct
- [ ] Verify `description` is accurate
- [ ] Verify `publisher` is correct (currently: kchikech)
- [ ] Verify `repository.url` points to correct GitHub repo
- [ ] Verify `bugs.url` points to correct issues page
- [ ] Verify `homepage` points to correct README
- [ ] Verify `keywords` are relevant for marketplace search
- [ ] Verify `icon` path is correct (images/logo.png)

## 📋 README.md Verification
- [ ] All links work (no 404s)
- [ ] Screenshots/GIFs are up to date
- [ ] Installation instructions are clear
- [ ] Feature list is complete
- [ ] Configuration examples are accurate
- [ ] Keyboard shortcuts are documented
- [ ] Troubleshooting section is helpful

## 📋 License and Legal
- [x] LICENSE file exists (MIT)
- [ ] Copyright year is current
- [ ] Author attribution is correct
- [ ] No proprietary code included
- [ ] All dependencies have compatible licenses

## 🧪 Testing
- [ ] Extension loads in VS Code without errors
- [ ] Chat interface works correctly
- [ ] All tools execute successfully
- [ ] Memory system works (if Qdrant available)
- [ ] MCP integration works (if configured)
- [ ] Settings are applied correctly
- [ ] Keyboard shortcuts work
- [ ] Works on Windows ✓
- [ ] Works on macOS (test if possible)
- [ ] Works on Linux (test if possible)

## 🔒 Security
- [x] No hardcoded credentials
- [x] No API keys in code
- [ ] No sensitive data in git history
- [x] Dangerous commands are blocked (rm -rf /, etc.)
- [x] File operations are sandboxed to workspace
- [x] User confirmation required for destructive actions

## 📦 Build and Package
- [ ] `npm run build` completes successfully
- [ ] `npx vsce package` creates VSIX without errors
- [ ] VSIX installs in VS Code successfully
- [ ] Extension activates without errors
- [ ] No console errors in Developer Tools

## 🌐 GitHub Repository Setup
- [ ] Create repository on GitHub (if not exists)
- [ ] Add repository description
- [ ] Add repository topics/tags (vscode, ollama, ai, llm, etc.)
- [ ] Enable Issues
- [ ] Enable Discussions (optional)
- [ ] Add repository social preview image (optional)
- [ ] Configure branch protection rules (optional)

## 📝 GitHub Release
- [ ] Create release tag: `v0.2.0`
- [ ] Release title: "OllamaPilot v0.2.0 - Multi-Tiered Memory System"
- [ ] Copy release notes from CHANGELOG.md
- [ ] Attach `ollamapilot-0.2.0.vsix` to release
- [ ] Mark as latest release

## 🚀 VS Code Marketplace
- [ ] Create publisher account (if not exists)
- [ ] Verify publisher ID matches package.json
- [ ] Run `npx vsce publish` to publish
- [ ] Verify extension appears on marketplace
- [ ] Test installation from marketplace
- [ ] Update README badges with marketplace links

## 📢 Post-Publish
- [ ] Announce on social media (optional)
- [ ] Post in VS Code community (optional)
- [ ] Post in Ollama community (optional)
- [ ] Monitor GitHub issues for bug reports
- [ ] Respond to marketplace reviews

## 🔄 Continuous Maintenance
- [ ] Set up GitHub Actions for CI/CD (optional)
- [ ] Configure automated testing (optional)
- [ ] Set up dependabot for dependency updates (optional)
- [ ] Plan next version features
- [ ] Monitor and respond to community feedback

---

## Quick Commands

### Build and Test
```bash
npm run build
npx vsce package
code --install-extension ollamapilot-0.2.0.vsix
```

### Publish to Marketplace
```bash
# First time: create token at https://dev.azure.com
npx vsce login kchikech

# Publish
npx vsce publish
```

### Create GitHub Release
```bash
git tag v0.2.0
git push origin v0.2.0
# Then create release on GitHub web interface
```

---

## Notes

- Keep CLEANUP_SUMMARY.md for reference but don't commit it to git
- This checklist can be deleted after successful publish
- Consider creating a RELEASE.md template for future versions
