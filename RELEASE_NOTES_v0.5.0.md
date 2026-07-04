# GarenMovies v0.5.0

Recherche de torrents intégrée. Depuis l'app, tu cherches un film ou une série, tu récupères le lien magnet, et tu l'envoies à ton client torrent en un clic — plus besoin d'aller sur un site à côté.

> Si tu es déjà en 0.4.0, cette mise à jour te sera proposée **automatiquement** au démarrage.

## Installation

1. Télécharge `GarenMovies-Setup-0.5.0.exe` ci-dessous
2. Lance l'installeur (Windows SmartScreen peut avertir car l'exe n'est pas signé — "Plus d'infos" → "Exécuter quand même")
3. Lance GarenMovies depuis le menu démarrer

## Nouveautés

### Recherche de torrents (onglet « Torrents »)
- Nouvel onglet **Torrents** côté hôte : tape un titre → résultats depuis **YTS + The Pirate Bay**, triés par seeders.
- Pour chaque résultat : nom, taille, seeders, source, et deux actions :
  - **Ouvrir** → envoie le lien magnet à ton client torrent (qBittorrent, etc.).
  - **Copier** → copie le magnet dans le presse-papiers.
- GarenMovies **ne télécharge rien lui-même** : il passe la main à ton client torrent.

### Zone de glisser-déposer
- Une zone en bas de l'onglet Torrents accepte :
  - un **lien magnet** ou un fichier **`.torrent`** → ouvert directement dans ton client torrent.
  - des **fichiers vidéo** → copiés dans le dossier de ta bibliothèque et détectés automatiquement.

## Configuration

Inchangée — **Paramètres** (⚙️) : pseudo, clé API TMDB (affiches), clé API OpenSubtitles (subs), langue par défaut.

## Prérequis

- Windows 10 / 11 (64 bits)
- Un client torrent installé (qBittorrent, etc.) pour ouvrir les magnets
- Connexion internet
- Optionnel : **VLC** installé pour le repli sur les conteneurs non standard

## Changelog technique

- `(0.5.0)` In-app torrent search via YTS + apibay (The Pirate Bay); magnet built from info-hash + public trackers
- `(0.5.0)` Drag & drop: .torrent / magnet → default client (shell.openExternal/openPath), video files → copied to the library folder
- `(0.5.0)` New Torrents tab (host only), IPC + webUtils.getPathForFile for dropped-file paths (Electron 33)
