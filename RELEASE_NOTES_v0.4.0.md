# GarenMovies v0.4.0

Mises à jour intégrées + confort d'usage. À partir de cette version, **plus besoin de repasser par git** : l'app détecte les nouvelles versions au démarrage et propose de les installer en un clic. Plus un lot d'améliorations demandées (plein écran invités, sous-titres partagés, meilleures affiches, menu scrollable).

## Installation

1. Télécharge `GarenMovies-Setup-0.4.0.exe` ci-dessous
2. Lance l'installeur (Windows SmartScreen peut avertir car l'exe n'est pas signé — "Plus d'infos" → "Exécuter quand même")
3. Lance GarenMovies depuis le menu démarrer

> Une fois en 0.4.0, les prochaines mises à jour se proposeront **automatiquement** dans l'app.

## Nouveautés

### Mises à jour automatiques
- Au démarrage, l'app vérifie s'il existe une version plus récente sur GitHub.
- Si oui → pop-up **« Mise à jour disponible → Télécharger »**, puis, une fois téléchargée, **« Redémarrer et installer »**.
- Rien à refaire à la main, plus de rebuild/download manuel.

### Plein écran pour les invités
- Un bouton **plein écran** est maintenant présent dans le lecteur pour **tout le monde**, y compris les invités (qui n'avaient pas les contrôles natifs). Le plein écran garde les menus audio/sous-titres accessibles.

### Sous-titres partagés avec le salon
- Quand l'hôte télécharge un sous-titre, il est **automatiquement activé chez tous les invités** (avant, il fallait que chacun se débrouille). La piste apparaît et s'active toute seule côté potes.

### Meilleures affiches (TMDB)
- Le nettoyage des noms de fichiers est beaucoup plus robuste : on coupe au niveau de l'année et on jette tous les tags techniques.
- Exemple : `The.Dark.Knight.2008.bluray.hdr.2160p.av1.5.1.opus.subs-Dust` → recherche **« The Dark Knight » (2008)** au lieu de la chaîne complète illisible. Beaucoup plus d'affiches trouvées.

### Menu de sous-titres scrollable
- Quand il y a beaucoup de pistes, le menu défile désormais au lieu de déborder hors de l'écran — la fin est enfin accessible.

## Configuration

Inchangée — **Paramètres** (⚙️) : pseudo, clé API TMDB (affiches), clé API OpenSubtitles (subs), langue par défaut. Accélération matérielle (NVENC/QSV/AMF) automatique.

## Prérequis

- Windows 10 / 11 (64 bits)
- Connexion internet (Cloudflare Tunnel, TMDB, OpenSubtitles, et la vérification des mises à jour)
- Optionnel : **VLC** installé pour le repli sur les conteneurs non standard

## Changelog technique

- `(0.4.0)` In-app auto-update via electron-updater (GitHub provider) + native update dialogs
- `(0.4.0)` Fullscreen control for everyone (Fullscreen API on the player wrapper)
- `(0.4.0)` Propagate downloaded subtitles to all viewers (`sub:activate` socket event)
- `(0.4.0)` Robust TMDB title parsing: cut at the release year / first scene tag
- `(0.4.0)` Scrollable overlay menu (max-height + overflow) for long subtitle lists
- `ea55ce7` Fix startup freeze: never run `vlc --version` on the main thread
- `9c48077` Progressive HLS playback: instant start for HEVC/x265 files
