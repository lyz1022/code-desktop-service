---
title: Code Remote Privacy Policy
---

# Code Remote Privacy Policy

Effective date: 2026-05-28

Code Remote is a HarmonyOS remote client for developers. It connects to `code-desktop-service`, a desktop service installed and paired by the user. The app only supports connecting to the user's paired Mac or Windows desktop service within a local area network or another local network directly accessible by the user. The app does not provide a public relay service, hosted AI model services, cloud code hosting, advertising SDKs, analytics SDKs, or payment SDKs.

## 1. Information Processed by the App

To support pairing, session synchronization, and file preview, the app may process the following information locally on the user's device:

- Pairing information: desktop name, desktop service URL, candidate service URLs, certificate fingerprint, public key hash, authorization token, pairing time, and authorization expiry time.
- Connection information: network state, desktop online state, recent connection time, and connection error messages.
- Session information: session title, session state, user prompts, assistant responses, approval requests, plan progress, file references, web links, and local preview state.
- User-selected files or images: processed only after the user chooses to upload, preview, save, or share them.
- Local cache: session details, attachment previews, images, documents, and web preview results may be cached locally to improve performance.

The app does not actively read contacts, messages, location, microphone, calendar, or other unrelated information.

## 2. Permission Usage

- Network permission: used to connect to the user's paired desktop service within a local area network or another local network directly accessible by the user for session sync, message sending, file transfer, and local web preview.
- Network state permission: used to detect network availability and help users discover or reconnect to the desktop service.
- Camera permission: used only to scan the pairing QR code shown on the desktop management page. The app does not take photos, record video, or store camera frames.
- Vibration permission: used for lightweight haptic feedback during pairing, sending, approval, and similar actions.

This version does not request the restricted gallery write permission. Images are saved to Gallery through the HarmonyOS system save control or authorization dialog. Other files are saved through the system file save panel, and the user confirms the save action in the corresponding system UI.

## 3. Storage

Pairing credentials and runtime cache are stored locally on the HarmonyOS device. Pairing credentials are stored with system secure storage. Session and attachment caches are stored in the app's local data directory. Users can unpair a desktop, clear cache, revoke permissions in system settings, or uninstall the app.

## 4. Transfer

After pairing, the app communicates with the user's paired desktop service over HTTPS/WebSocket. Session content, prompts, attachments, images, and web preview links may be transferred between the HarmonyOS device and that desktop service.

The app developer does not provide a public relay server, cloud code hosting service, or cloud storage service for user code, session content, or attachments. User prompts, session content, file lists, and attachments are transferred only between the user's HarmonyOS device and the desktop service paired by the user.

If the user configures Codex, Claude Code, openclaw, hermes, or other AI coding tools on the desktop, those tools may send relevant content to their corresponding services according to the user's actions and configuration. Such processing is governed by the terms and privacy policies of the third-party tools selected by the user.

## 5. Third-Party SDKs and Sharing

The app currently does not include advertising SDKs, analytics SDKs, payment SDKs, or social login SDKs. Apart from the user's paired desktop service and user-configured third-party AI tools, the app developer does not operate a cloud server to receive user session content or code content and does not provide public relay, cloud synchronization, or cloud code hosting services.

## 6. User Rights

Users can:

- Unpair a desktop service.
- Re-authorize by scanning a new QR code.
- Clear local cache.
- Revoke camera and other permissions in system settings.
- Delete files saved through the system save control, authorization dialog, or system save panel.
- Contact the developer through GitHub Issues or the app marketplace developer contact channel.

## 7. Children

The app is intended for developers and is not primarily directed to children. Minors should use the app only with consent and guidance from a guardian.

## 8. Contact

For privacy questions, contact:

- GitHub Issues: https://github.com/lyz1022/code-desktop-service/issues
- App marketplace developer contact: as configured in the marketplace console

## 9. Updates

When app features, permissions, or data processing practices change materially, this privacy policy will be updated and the change will be reflected in release notes or the app marketplace listing.
