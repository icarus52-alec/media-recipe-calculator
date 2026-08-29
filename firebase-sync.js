const bridge = window.mediaRecipeSyncBridge;
const config = window.MEDIA_RECIPE_FIREBASE_CONFIG || {};
const syncButton = document.getElementById('syncButton');
let currentUser = null;
let unsubscribe = null;
let ready = false;
let uploadTimer = null;
let lastUploaded = '';
let status = 'signed-out';

const configured = ['apiKey', 'authDomain', 'projectId', 'appId'].every(key => String(config[key] || '').trim());
const text = (zh, en) => bridge.t(zh, en);
const stateText = () => {
  if (!configured) return [text('尚未設定同步', 'Sync setup needed'), text('本機資料仍可正常使用；完成 Firebase 設定後即可登入同步。', 'Local data still works. Complete Firebase setup to enable sign-in and sync.')];
  if (status === 'syncing') return [text('同步中…', 'Syncing…'), text('正在同步你的配方。', 'Syncing your recipes.')];
  if (status === 'signed-in') return [text('已同步', 'Synced'), text(`已使用 ${currentUser?.email || ''} 自動同步。`, `Automatically syncing as ${currentUser?.email || ''}.`)];
  if (status === 'error') return [text('同步錯誤', 'Sync error'), text('目前保留在本機，稍後可再次嘗試同步。', 'Your data remains on this device. Try syncing again later.')];
  return [text('登入同步', 'Sign in to sync'), text('資料儲存在此瀏覽器；登入後可跨裝置自動同步。', 'Data is stored in this browser. Sign in to sync it across devices.')];
};
function renderStatus() {
  const [label, note] = stateText();
  bridge.setStatus(status, label, note);
}
bridge.refreshLanguage = renderStatus;

if (!configured) {
  status = 'setup';
  renderStatus();
  syncButton.onclick = () => alert(text('Firebase 尚未完成設定。請先依照設定說明建立免費專案。', 'Firebase setup is not complete yet. Create the free project first.'));
} else {
  startFirebase().catch(error => {
    console.error(error);
    status = 'error';
    renderStatus();
  });
}

async function startFirebase() {
  const version = '12.18.0';
  const [{ initializeApp }, authApi, firestoreApi] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-firestore.js`)
  ]);
  const app = initializeApp(config);
  const auth = authApi.getAuth(app);
  const db = firestoreApi.getFirestore(app);
  await authApi.setPersistence(auth, authApi.browserLocalPersistence);

  syncButton.onclick = async () => {
    if (currentUser) {
      if (confirm(text(`要登出 ${currentUser.email} 嗎？`, `Sign out of ${currentUser.email}?`))) await authApi.signOut(auth);
      return;
    }
    try {
      const provider = new authApi.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await authApi.signInWithPopup(auth, provider);
    } catch (error) {
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) {
        await authApi.signInWithRedirect(auth, new authApi.GoogleAuthProvider());
      } else if (error.code !== 'auth/popup-closed-by-user') {
        throw error;
      }
    }
  };

  bridge.onSave(nextState => {
    if (!currentUser || !ready) return;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => upload(nextState), 700);
  });

  authApi.onAuthStateChanged(auth, user => {
    currentUser = user;
    ready = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (!user) {
      status = 'signed-out';
      renderStatus();
      return;
    }
    status = 'syncing';
    renderStatus();
    const userDoc = firestoreApi.doc(db, 'users', user.uid);
    let firstSnapshot = true;
    unsubscribe = firestoreApi.onSnapshot(userDoc, { includeMetadataChanges: true }, async snapshot => {
      if (snapshot.metadata.hasPendingWrites) return;
      const remote = snapshot.exists() ? snapshot.data().state : null;
      if (firstSnapshot) {
        firstSnapshot = false;
        const local = bridge.getState();
        const combined = remote ? mergeStates(local, remote) : local;
        bridge.replaceState(combined);
        ready = true;
        status = 'signed-in';
        renderStatus();
        if (!remote || JSON.stringify(combined) !== JSON.stringify(remote)) await upload(combined, userDoc, firestoreApi);
        return;
      }
      if (remote && JSON.stringify(remote) !== JSON.stringify(bridge.getState())) bridge.replaceState(remote);
      status = 'signed-in';
      renderStatus();
    }, error => {
      console.error(error);
      status = 'error';
      renderStatus();
    });
  });

  async function upload(nextState, target = firestoreApi.doc(db, 'users', currentUser.uid), api = firestoreApi) {
    if (!currentUser) return;
    const serialized = JSON.stringify(nextState);
    if (serialized === lastUploaded) return;
    status = 'syncing';
    renderStatus();
    try {
      await api.setDoc(target, { state: nextState, updatedAt: api.serverTimestamp() });
      lastUploaded = serialized;
      status = 'signed-in';
    } catch (error) {
      console.error(error);
      status = 'error';
    }
    renderStatus();
  }
}

function mergeStates(local, remote) {
  if (!local?.recipes?.length) return remote;
  if (!remote?.recipes?.length) return local;
  const recipes = new Map(remote.recipes.map(recipe => [recipe.id, recipe]));
  for (const recipe of local.recipes) {
    const cloudRecipe = recipes.get(recipe.id);
    if (!cloudRecipe || Date.parse(recipe.updatedAt || 0) > Date.parse(cloudRecipe.updatedAt || 0)) recipes.set(recipe.id, recipe);
  }
  return { ...remote, ...local, recipes: [...recipes.values()] };
}
