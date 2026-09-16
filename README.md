# Quinté+ Live — version 2

Cette version reprend la base précédente et ajoute une gestion automatique du cycle quotidien.

## Fonctionnement
- À **07:00**, le Quinté du nouveau jour devient la course affichée.
- L'annonce de la course reste affichée pendant l'attente : hippodrome, horaire, détails, partants et cotes lorsqu'elles sont fournies par le flux PMU.
- Dès que les **5 premiers officiels** sont disponibles, ils remplacent automatiquement l'annonce sur la page principale.
- Les résultats officiels sont enregistrés dans `data/history.json` et conservés **48 heures**.
- Une synchronisation serveur tourne toutes les 30 secondes : le résultat peut donc être enregistré même lorsqu'aucun visiteur n'a la page ouverte.
- Avant 07:00, le cycle reste celui de la veille : le résultat de la veille peut donc rester affiché jusqu'à 07:00.

## Installation Windows
1. Décompresser le ZIP.
2. Ouvrir le dossier `quinte-live`.
3. Dans la barre d'adresse de l'Explorateur, taper `cmd` puis Entrée.
4. Exécuter : `npm install`
5. Puis : `npm start`
6. Ouvrir : `http://localhost:3000`

## Configuration
Copier `.env.example` vers `.env` si besoin.
- `APP_TIMEZONE=Indian/Reunion` pour une bascule à 07:00 heure de La Réunion.
- `DAY_START_HOUR=7` pour changer l'heure de bascule.
- `REFRESH_SECONDS=30` pour changer la fréquence de contrôle PMU.

## Déploiement
Le fichier `data/history.json` fonctionne pour une instance qui reste active. Sur un hébergeur avec disque éphémère, comme certaines configurations gratuites, l'historique peut être perdu après un redémarrage. Pour une conservation réellement persistante en production, il faudra ensuite brancher une base de données ou un stockage persistant.

## API
- `/api/quinte` : affichage courant du cycle + historique récent.
- `/api/history` : historique des résultats conservés.
- `/api/health` : état du serveur.


## Pronostics et dons
- Copie `.env.example` vers `.env`.
- Remplace `CHANGE-MOI` par un mot de passe administrateur.
- Mets ton lien de don dans `DONATION_URL` (laisser vide si tu ne l'as pas encore).
- Lance le site puis ouvre `/admin.html` pour publier tes pronostics.
- Les pronostics sont stockés dans `data/pronostics.json`.


## Version 1.1 — identité visuelle et pronostic du jour
- Nouveau logo tête de cheval stylisée, classique bleu marine et doré.
- En-tête et navigation modernisés, adaptés au mobile.
- Un seul pronostic actif : une nouvelle publication remplace automatiquement le précédent.
- Le pronostic est lié au cycle quotidien de 7 h et l'ancien n'est plus affiché au cycle suivant.
- Le cycle et la conservation des résultats restent côté serveur.

## V4 — présentation premium
- En-tête premium inspiré de la maquette validée : cheval doré, QUINTÉ+ LIVE et scène de course.
- Navigation sombre bleu marine avec accents dorés.
- Conservation du fonctionnement automatique des résultats et des pronostics.
