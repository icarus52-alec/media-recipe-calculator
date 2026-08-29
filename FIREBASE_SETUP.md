# Firebase sync setup

1. Create a Firebase project on the free Spark plan. Google Analytics is not required.
2. Add a Web app and copy its `firebaseConfig` values into `firebase-config.js`.
3. In Authentication, enable the Google sign-in provider.
4. Under Authentication settings, add `icarus52-alec.github.io` as an authorized domain.
5. Create a Cloud Firestore database and publish the contents of `firestore.rules` as its rules.
6. Commit and publish the updated files. Sign in with the same Google account on each device.

The Firebase web configuration is not a secret. The Firestore security rules are what keep each account's data private.
