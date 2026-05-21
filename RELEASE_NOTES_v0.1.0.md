# GarenMovies v0.1.0

Première release de **GarenMovies**, une application desktop Electron pour organiser des watch-parties depuis chez soi : tu héberges tes films sur ton PC, tes amis se connectent à un salon partagé via internet (Cloudflare Tunnel) ou en LAN, et tout le monde regarde de manière synchronisée.

## Installation

1. Télécharge `GarenMovies-Setup-0.1.0.exe` ci-dessous
2. Lance l'installeur (Windows SmartScreen peut afficher un warning car l'exe n'est pas signé — clique "Plus d'infos" → "Exécuter quand même")
3. Lance GarenMovies depuis le menu démarrer ou le raccourci bureau

## Fonctionnalités principales

### Hébergement d'un salon
- Scan d'un dossier local pour exposer ses films
- Activation en un clic d'un tunnel Cloudflare pour partager hors LAN
- URL ou code à transmettre aux invités
- Compteur d'invités connectés

### Catalogue
- Vue grille avec affiches récupérées via TMDB (clé API gratuite à configurer dans les Paramètres)
- Affiches spécifiques à la saison pour les séries (Euphoria S03 → poster S03)
- Regroupement automatique des épisodes d'une même série + saison en une carte unique avec un sélecteur d'épisodes
- Titres officiels d'épisodes via TMDB

### Lecteur
- Playback synchronisé entre l'hôte et les invités (timestamp + play/pause/seek)
- Menu sous-titres style VLC : sidecar `.srt`/`.vtt` détectés automatiquement, ainsi que les pistes intégrées dans les MKV (extraction via `matroska-subtitles`)
- Menu piste audio : ffmpeg-static bundlé pour remuxer à la volée vers AAC les pistes AC-3 / DTS / autres codecs incompatibles avec le navigateur, plus tag `hvc1` automatique pour les vidéos HEVC
- Cache disque des pistes audio remuxées (1ʳᵉ lecture lente, suivantes instantanées)
- Préservation de la position et de l'état de lecture lors d'un changement de piste audio

### Chat & UX
- Panneau chat coulissant à droite avec historique persistant côté serveur, badge "Hôte", compteur de messages non lus
- Pseudos personnalisables (sauvegardés en localStorage)
- Design dark moderne avec icônes Lucide, animations fluides, blur backdrops

## Configuration

À la première utilisation :
1. Ouvre les **Paramètres** (icône engrenage en haut à droite)
2. Renseigne ton **pseudo** pour le chat
3. Optionnellement, colle ta clé API TMDB (gratuite : https://www.themoviedb.org/settings/api) pour récupérer les affiches. Tes invités n'ont pas besoin de leur propre clé.

## Prérequis

- Windows 10 / 11 (64 bits)
- Connexion internet pour Cloudflare Tunnel et la récupération des affiches TMDB

## Limitations connues

- L'installeur n'est pas signé numériquement (warning Windows SmartScreen au lancement)
- Les URLs Cloudflare Quick Tunnel sont éphémères (changent à chaque redémarrage du salon)
- macOS et Linux non packagés dans cette release (le code est cross-platform mais seul le build Windows est fourni)
