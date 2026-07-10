#!/bin/sh
# ISMS Builder – Docker Entrypoint
# Stellt sicher, dass alle benötigten Datenverzeichnisse vorhanden sind,
# bevor der Server gestartet wird (wichtig bei Bind-Mount auf leerem Host-Verzeichnis)
set -e

mkdir -p \
  /app/data/gdpr/files \
  /app/data/guidance/files \
  /app/data/template-files \
  /app/data/legal/files

# Läuft als root (s. Dockerfile): chownt data/ (bind-gemountet, ggf. fremder
# Owner auf dem Host) auf den unprivilegierten isms-User und wechselt dann
# per su-exec dorthin, bevor der Node-Prozess startet.
chown -R isms:isms /app/data

exec su-exec isms node server/index.js
