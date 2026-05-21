# GarenMovies v0.2.0

Deuxième release. Surtout consacrée aux sous-titres : téléchargement automatique depuis OpenSubtitles, décalage manuel pour resynchroniser à la volée, et un paquet de fixes (layout du catalogue, crash sur MKV mal formés, etc.).

## Installation

1. Télécharge `GarenMovies-Setup-0.2.0.exe` ci-dessous
2. Lance l'installeur (Windows SmartScreen peut avertir car l'exe n'est pas signé — "Plus d'infos" → "Exécuter quand même")
3. Lance GarenMovies depuis le menu démarrer

## Nouveautés

### Sous-titres en ligne (OpenSubtitles)
- Bouton **Rechercher en ligne** dans le menu CC du lecteur
- Recherche automatiquement contextualisée par les métadonnées TMDB (titre + année pour les films, série + saison + épisode pour les TV shows)
- Sélecteur de langue (FR / EN / ES / IT / DE / PT / RU / JA), résultats triés par popularité avec badges Trusted / HD / SDH / Auto-traduit, compteur de téléchargements et notes
- Téléchargement → cache local sur l'hôte (`userData/downloaded-subs/`) → diffusion à tous les invités du salon → **auto-activation** de la nouvelle piste
- **20 téléchargements/jour** gratuits avec un compte OpenSubtitles ; les invités utilisent transparente la clé de l'hôte (aucune configuration de leur côté)

### Décalage des sous-titres
- Panneau **Décalage** dans le menu CC quand une piste est active
- 4 boutons ±0.1 s / ±0.5 s pour ajuster manuellement
- **Aligner ici** : positionne la phrase la plus proche sur la frame courante (auto-sync façon VLC)
- **Reset** pour repartir à zéro
- Le décalage est **local par viewer** : chacun peut affiner ses propres subs sans affecter les autres

### Layout & polish
- Grille du catalogue corrigée : les cartes ne s'effondrent plus en mode épisode (le `<button>` héritait des propriétés flex centrées du style global, désormais explicitement override)
- Cleanup étendu des noms de fichiers : `ITA`, `ENG`, `WEBMux`, `DLMux`, `BDMux`, `REPACK`, `PROPER`, `HDR`, `DV`, etc. sont strippés du titre affiché
- Détection automatique des séries même quand le marqueur d'épisode est au début du nom (`2x01 Il Controllo…`) : le nom de la série est pris depuis le dossier parent

### Stabilité
- Plus de crash Electron sur les MKV avec un header EBML malformé (HEVC 10-bit BluRay et certains rips fan-made). Le pipeline d'extraction utilise `stream.pipeline()` pour capturer les throws synchrones, et un handler `uncaughtException` global empêche toute lib tierce d'abattre l'app principale
- Les fichiers qui plantent au probe sont ignorés pour le reste de la session (plus de boucle scan→crash→relance)
- Les sorties d'erreur ebml-stream qui balançaient 100 KB de zéros dans la console sont maintenant tronquées à 800 caractères

## Configuration

Dans les **Paramètres** (⚙️ en haut à droite) :
- **Pseudo** pour le chat
- **Clé API TMDB** (optionnelle, pour les affiches) — compte gratuit sur https://www.themoviedb.org/settings/api
- **Clé API OpenSubtitles** (optionnelle, pour la recherche de subs) — compte gratuit sur https://www.opensubtitles.com/fr/consumers (créer une "App")
- **Langue par défaut** des sous-titres recherchés

Les invités du salon n'ont besoin de configurer que leur pseudo — affiches et subs leur sont transmis directement par l'hôte.

## Prérequis

- Windows 10 / 11 (64 bits)
- Connexion internet (pour Cloudflare Tunnel, TMDB, et OpenSubtitles)

## Changelog technique

- `4856b4a` Add manual subtitle offset + auto-sync to current frame
- `1e072c8` Fix catalogue card layout collapse + clean Italian/release-tagged filenames
- `3cf8a80` Prevent crash on malformed MKV during subtitle probe
- `bf7ca22` Add online subtitle search and download via OpenSubtitles
- `9ec48ef` Fix subtitle display + codec-aware audio playback
