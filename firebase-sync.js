const bridge = window.mediaRecipeSyncBridge;
const config = window.MEDIA_RECIPE_FIREBASE_CONFIG || {};
const syncButton = document.getElementById('syncButton');
const ownerUid = String(config.ownerUid || '');
let currentUser = null;
let isOwner = false;
let masterExists = false;
let ready = false;
let uploadTimer = null;
let lastUploaded = '';
let status = 'read-only';

const configured = ['apiKey', 'authDomain', 'projectId', 'appId', 'ownerUid'].every(key => String(config[key] || '').trim());
const text = (zh, en) => bridge.t(zh, en);
const serialize = value => JSON.stringify(value, (_, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.keys(item).sort().reduce((sorted, key) => {
    sorted[key] = item[key];
    return sorted;
  }, {});
});
const stateText = () => {
  if (!configured) return [text('尚未設定配方庫', 'Library setup needed'), text('本機資料仍可正常使用。', 'Local data still works.')];
  if (status === 'syncing') return [text('同步中…', 'Syncing…'), text('正在更新公開主配方庫。', 'Updating the public master library.')];
  if (status === 'owner') return [text('管理者已同步', 'Owner synced'), text(`管理者：${currentUser?.email || ''}`, `Owner: ${currentUser?.email || ''}`)];
  if (status === 'error') return [text('連線錯誤', 'Connection error'), text('目前顯示裝置中最後保存的配方。', 'Showing the last recipes saved on this device.')];
  return [text('管理者登入', 'Owner sign-in'), text('唯讀模式：可使用換算，但只有管理者能修改配方。', 'Read-only: calculations are available, but only the owner can edit recipes.')];
};
function renderStatus() {
  const [label, note] = stateText();
  bridge.setStatus(status, label, note);
}
bridge.refreshLanguage = renderStatus;
bridge.setOwnerMode(false);

if (!configured) {
  status = 'setup';
  renderStatus();
  syncButton.onclick = () => alert(text('Firebase 尚未完成設定。', 'Firebase setup is not complete yet.'));
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
  const masterDoc = firestoreApi.doc(db, 'libraries', 'master');
  await authApi.setPersistence(auth, authApi.browserLocalPersistence);

  syncButton.onclick = async () => {
    if (isOwner) {
      if (confirm(text(`要登出管理帳號 ${currentUser.email} 嗎？`, `Sign out of the owner account ${currentUser.email}?`))) await authApi.signOut(auth);
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
    if (!isOwner || !ready) return;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => upload(nextState), 700);
  });

  firestoreApi.onSnapshot(masterDoc, { includeMetadataChanges: true }, snapshot => {
    if (snapshot.metadata.hasPendingWrites) return;
    masterExists = snapshot.exists();
    if (masterExists) {
      const remote = snapshot.data().state;
      if (remote && serialize(remote) !== serialize(bridge.getState())) bridge.replaceState(remote);
      if (remote) lastUploaded = serialize(remote);
    }
    ready = isOwner;
    status = isOwner ? 'owner' : 'read-only';
    renderStatus();
  }, error => {
    console.error(error);
    status = 'error';
    renderStatus();
  });

  authApi.onAuthStateChanged(auth, async user => {
    currentUser = user;
    isOwner = user?.uid === ownerUid;
    bridge.setOwnerMode(isOwner);
    if (user && !isOwner) {
      bridge.toast(text('此帳號沒有配方編輯權限', 'This account does not have permission to edit recipes'));
      await authApi.signOut(auth);
      return;
    }
    if (!isOwner) {
      ready = false;
      status = 'read-only';
      renderStatus();
      return;
    }
    ready = true;
    status = 'syncing';
    renderStatus();
    if (!masterExists) {
      const legacyDoc = firestoreApi.doc(db, 'users', ownerUid);
      try {
        const legacySnapshot = await firestoreApi.getDoc(legacyDoc);
        const legacyState = legacySnapshot.exists() ? legacySnapshot.data().state : null;
        if (legacyState?.recipes?.length) bridge.replaceState(legacyState);
      } catch (error) {
        console.warn('Legacy recipe migration was skipped.', error);
      }
      await upload(bridge.getState());
    } else {
      status = 'owner';
      renderStatus();
    }
  });

  async function upload(nextState) {
    if (!isOwner) return;
    const serialized = serialize(nextState);
    if (serialized === lastUploaded) {
      status = 'owner';
      renderStatus();
      return;
    }
    status = 'syncing';
    renderStatus();
    try {
      await firestoreApi.setDoc(masterDoc, { state: nextState, ownerUid, updatedAt: firestoreApi.serverTimestamp() });
      lastUploaded = serialized;
      masterExists = true;
      status = 'owner';
    } catch (error) {
      console.error(error);
      status = 'error';
    }
    renderStatus();
  }
}
