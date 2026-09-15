# Quinté+ Live — version PMU sans clé

Cette version remplace turf.bzh par le flux JSON public `turfinfo.api.pmu.fr` utilisé par les données PMU.

## Installation Windows

1. Décompressez le ZIP.
2. Ouvrez le dossier `quinte-live`.
3. Dans la barre d'adresse de l'Explorateur, tapez `cmd` puis Entrée.
4. Tapez :

```bat
npm install
npm start
```

5. Ouvrez http://localhost:3000

Le site vérifie les données toutes les 30 secondes.

## Important

Cette version utilise des endpoints JSON publics/non documentés du flux turfinfo PMU. Ils peuvent changer ou être bloqués à l'avenir. Pour une utilisation publique commerciale ou une republication massive, vérifiez les conditions d'utilisation du fournisseur.
