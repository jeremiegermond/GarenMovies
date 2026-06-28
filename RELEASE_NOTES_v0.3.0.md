# GarenMovies v0.3.0

Troisième release, entièrement consacrée au lecteur : **un lecteur qui marche pour tout et qui démarre vite**, comme un site de streaming. Les fichiers HEVC/x265 10-bit (la majorité des releases modernes) qui mettaient plusieurs minutes — voire échouaient — se lancent maintenant en **~1 seconde**.

## Installation

1. Télécharge `GarenMovies-Setup-0.3.0.exe` ci-dessous
2. Lance l'installeur (Windows SmartScreen peut avertir car l'exe n'est pas signé — "Plus d'infos" → "Exécuter quand même")
3. Lance GarenMovies depuis le menu démarrer

## Nouveautés

### Lecture progressive (streaming à la volée)
- Les vidéos que le navigateur ne sait pas lire directement (HEVC/x265, 10-bit, AC3/DTS…) sont désormais **transcodées en flux HLS** et la lecture **démarre dès le premier segment** (~1 s) au lieu d'attendre que tout le fichier soit converti.
- Le transcodage tourne **~9× plus vite que le temps réel** (accélération matérielle NVENC) et reste loin devant la lecture — donc **aucune coupure**.
- Concrètement : un épisode HEVC 10-bit qui demandait ~19 min de préparation avant la moindre image se lance maintenant **immédiatement**.
- Approche **additive** : les anciens modes (lecture brute, remux audio, transcodage MP4) restent en place comme filets de sécurité.

### Transcodage matériel HEVC 10-bit corrigé
- NVENC ne sait pas encoder du 10-bit en H.264 : la conversion 10→8 bit est maintenant faite **sur le GPU** (`scale_cuda`) avant l'encodeur. Sans ça, le transcodage plantait sur quasiment toutes les releases x265 modernes (« 10 bit encode not supported »).
- Décodage **et** encodage sur le GPU (NVENC + CUDA, avec repli QSV / AMF / logiciel selon la machine).

### Sélection de piste audio fiable
- Le mapping de piste (`-map 0:a:N`) est appliqué de bout en bout, y compris dans le flux HLS : choisir **Anglais** joue bien l'anglais, même sur un fichier multi-pistes ITA/ENG.
- `Cache-Control: no-store` sur les flux pour éviter qu'un changement de piste rejoue l'ancienne depuis le cache du navigateur.

### Messages clairs sur les fichiers cassés
- Les fichiers **vides ou incomplets** (téléchargements torrent jamais terminés — que des octets nuls, aucune vidéo dedans) sont détectés **avant** de lancer le moteur et affichent un message explicite (« Fichier vide ou corrompu — re-télécharge ce fichier ») au lieu du charabia `EBML header parsing failed`.

### Repli VLC pour les conteneurs récalcitrants
- Quand ffmpeg refuse un MKV non standard, on bascule automatiquement sur **VLC** comme démuxeur (plus permissif), puis une passe rapide remet l'index MP4 en tête de fichier (`+faststart`) pour un démarrage immédiat.

## Robustesse

- Écriture **atomique** des fichiers de cache (`.tmp` → renommage final) : un Ctrl+C en plein transcodage ne laisse plus de fichier à moitié écrit qui passait le contrôle de taille mais ne se lisait pas.
- Nettoyage au démarrage des segments HLS partiels et des `.tmp` orphelins ; les transcodages en arrière-plan sont arrêtés quand on ferme l'app.
- Détection du matériel (encodeurs/accélérations) pré-chauffée au lancement pour ne pas payer la latence au premier transcodage.

## Configuration

Inchangée par rapport à la v0.2.0 — dans les **Paramètres** (⚙️ en haut à droite) : pseudo, clé API TMDB (affiches), clé API OpenSubtitles (recherche de subs), langue par défaut. Les invités n'ont besoin de configurer que leur pseudo.

Pour la lecture progressive, l'**accélération matérielle** est utilisée automatiquement si un GPU compatible est présent (NVIDIA NVENC, Intel QSV, AMD AMF) ; sinon repli logiciel.

## Prérequis

- Windows 10 / 11 (64 bits)
- Connexion internet (pour Cloudflare Tunnel, TMDB, et OpenSubtitles)
- Optionnel mais recommandé : **VLC** installé (https://www.videolan.org/) pour le repli sur les conteneurs non standard

## Changelog technique

- `f21625e` no-store on MP4 streams + VLC faststart post-process
- `297df06` Hardware-accelerated transcode: NVENC/QSV/AMF + HW decode where possible
- `2f88f95` Fix: prepare endpoint lied 'ready' without producing a cache file
- `b1aef12` Suppress matroska-subtitles noise + verbose VLC fallback logs
- `8a16351` Make ffprobe failures visible + log every remux-job entry point
- `44d7075` Validate remux output + log the exact ffmpeg/VLC command
- `b910b7d` Newer ffprobe + H.264 transcode fallback for files that won't decode
- `98e3f53` Rewrite Player audio logic with a simple state machine
- `76eb96a` Fall back to VLC when ffmpeg can't parse the input MKV
- `896576d` Fix A/V desync, broken cache + reactive remux fallback
- _(cette release)_ Progressive HLS transcoding + NVENC 10-bit fix + corrupt-file detection
