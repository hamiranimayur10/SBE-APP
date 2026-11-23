
    (function () {
      'use strict';

      const STORAGE_KEY = 'badminton_tournament_state_v1';
      const REGISTRY_KEY = 'badminton_tournaments_registry_v1';
      const THEME_KEY = 'badminton_tournament_theme_v1';
      const PLAYER_PROFILES_KEY = 'badminton_player_profiles_v1';
      const ANONYMIZED_PLAYER_PATTERN = /^Anonymous Player [a-f0-9]{16}$/i;
      const DEFAULT_PIN = '2025';
      const playerInviteToken = new URLSearchParams(window.location.search).get('playerInvite') || '';
      let spreadsheetParserPromise = null;
      const PAGE_FILES = Object.freeze({
        dashboard: 'index.html',
        tournaments: 'tournaments.html',
        setup: 'setup.html',
        qr1: 'qualifier-round-1.html',
        qr2: 'qualifier-round-2.html',
        semis: 'semifinals.html',
        finals: 'finals.html',
        bracket: 'bracket.html',
        players: 'players.html',
        checkin: 'check-in.html',
        rules: 'rules.html'
      });
      const PLAYER_IMPORT_FIELDS = [
        { key: 'name', label: 'Player name', required: true, headers: ['player name', 'full name', 'name', 'player'] },
        { key: 'playerCode', label: 'Six-digit player code', headers: ['player code', 'six digit code', 'unique code'] },
        { key: 'playerId', label: 'Internal player UUID', headers: ['player id', 'unique player id', 'unique id', 'uuid'] },
        { key: 'nickname', label: 'Nickname', headers: ['nickname', 'nick name'] },
        { key: 'email', label: 'Email', headers: ['email', 'email address'] },
        { key: 'club', label: 'Club / Academy', headers: ['club', 'academy', 'club academy'] },
        { key: 'gender', label: 'Gender', headers: ['gender', 'sex'] },
        { key: 'country', label: 'Country', headers: ['country'] },
        { key: 'state', label: 'State', headers: ['state', 'province'] },
        { key: 'city', label: 'City', headers: ['city'] },
        { key: 'emergencyContact', label: 'Emergency contact', headers: ['emergency contact', 'emergency phone'] },
        { key: 'playingHand', label: 'Playing hand', headers: ['playing hand', 'hand'] },
        { key: 'preferredEvents', label: 'Preferred events', headers: ['preferred events', 'events'] },
        { key: 'photoUrl', label: 'Profile photo URL', headers: ['photo url', 'photo', 'profile photo'] },
        { key: 'age', label: 'Age', headers: ['age'] },
        { key: 'ranking', label: 'National / Club ranking', headers: ['ranking', 'rank'] },
        { key: 'aliases', label: 'Other names / aliases', headers: ['aliases', 'other names', 'former names'] }
      ];

      function getPageUrl(page) {
        const url = new URL(PAGE_FILES[page] || PAGE_FILES.dashboard, window.location.href);
        const params = new URLSearchParams(window.location.search);
        ['api', 'playerInvite'].forEach(key => {
          if (params.has(key)) url.searchParams.set(key, params.get(key));
        });
        if (state?.tournamentId) url.searchParams.set('t', state.tournamentId);
        if (page === 'players' && params.has('player')) url.searchParams.set('player', params.get('player'));
        return `${url.pathname}${url.search}`;
      }

      function isAnonymizedPlayerName(name) {
        return ANONYMIZED_PLAYER_PATTERN.test(String(name || '').trim());
      }

      function getRequestedPage() {
        const page = document.body.dataset.page || 'dashboard';
        return PAGE_FILES[page] ? page : 'dashboard';
      }

      function createUniqueId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }

      function createPlayerCode(usedCodes) {
        const range = 900000;
        const random = new Uint32Array(1);
        window.crypto.getRandomValues(random);
        const start = random[0] % range;
        for (let offset = 0; offset < range; offset++) {
          const code = String(100000 + ((start + offset) % range));
          if (!usedCodes.has(code)) return code;
        }
        throw new Error('All six-digit player codes are in use');
      }

      function compressProfilePhoto(file) {
        return new Promise((resolve, reject) => {
          if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
            reject(new Error('Choose a JPEG, PNG, or WebP image'));
            return;
          }
          if (file.size > 10 * 1024 * 1024) {
            reject(new Error('Choose an image smaller than 10 MB'));
            return;
          }
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('Could not read the selected image'));
          reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error('The selected file is not a valid image'));
            image.onload = () => {
              const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
              canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
              const context = canvas.getContext('2d');
              if (!context) {
                reject(new Error('Photo compression is not supported by this browser'));
                return;
              }
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              for (const quality of [0.82, 0.72, 0.62, 0.5]) {
                const photo = canvas.toDataURL('image/jpeg', quality);
                if (photo.length <= 900000) {
                  resolve(photo);
                  return;
                }
              }
              reject(new Error('Could not compress the photo below the 675 KB limit'));
            };
            image.src = String(reader.result || '');
          };
          reader.readAsDataURL(file);
        });
      }

      function bindProfilePhotoControls(prefix) {
        const urlInput = document.getElementById(`${prefix}-photo-url`);
        const dataInput = document.getElementById(`${prefix}-photo-data`);
        const fileInput = document.getElementById(`${prefix}-photo-file`);
        const preview = document.getElementById(`${prefix}-photo-preview`);
        const clearButton = document.getElementById(`${prefix}-photo-clear`);
        const updatePreview = () => {
          const value = dataInput.value || urlInput.value.trim();
          let valid = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 900000;
          if (!valid && value) {
            try {
              const parsed = new URL(value);
              valid = parsed.protocol === 'https:' || parsed.protocol === 'http:';
            } catch (_err) {}
          }
          preview.hidden = !valid;
          if (valid) preview.src = value;
        };
        urlInput.addEventListener('input', () => {
          dataInput.value = '';
          updatePreview();
        });
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files?.[0];
          if (!file) return;
          try {
            dataInput.value = await compressProfilePhoto(file);
            urlInput.value = '';
            updatePreview();
          } catch (err) {
            showToast(err.message, 'error');
          } finally {
            fileInput.value = '';
          }
        });
        clearButton.addEventListener('click', () => {
          dataInput.value = '';
          urlInput.value = '';
          fileInput.value = '';
          updatePreview();
        });
        updatePreview();
      }

      function getProfilePhotoValue(prefix) {
        return document.getElementById(`${prefix}-photo-data`).value
          || document.getElementById(`${prefix}-photo-url`).value.trim();
      }

      function normalizeImportName(name) {
        return String(name || '')
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim()
          .replace(/\s+/g, ' ')
          .toLocaleLowerCase();
      }

      function normalizeImportHeader(header) {
        return String(header || '').normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
      }

      function isValidPlayerId(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
      }

      async function navigateToPage(page) {
        if (!PAGE_FILES[page] || page === getRequestedPage()) return;
        if (state.auth.role !== 'admin' && page === 'setup') return;
        if (state.auth.role === 'admin' && getSyncApiUrl() &&
            (syncTimer || syncInFlight || state.sync.status === 'pending')) {
          clearTimeout(syncTimer);
          syncTimer = null;
          do {
            if (!await pushToTurso(true)) return;
            clearTimeout(syncTimer);
            syncTimer = null;
          } while (state.sync.status === 'pending');
        }
        state.ui.activeTab = page;
        saveRegistry();
        window.location.assign(getPageUrl(page));
      }

      function bindPageLinks() {
        document.querySelectorAll('a[data-tab]').forEach(link => {
          link.addEventListener('click', event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            const page = link.getAttribute('data-tab');
            const ownPlayerCard = state.auth.role === 'player' && page === 'players' && playerAccountProfile;
            if (ownPlayerCard) {
              state.ui.selectedPlayerName = playerAccountProfile.name;
            }
            if (page === getRequestedPage()) {
              if (ownPlayerCard) render();
              return;
            }
            navigateToPage(page);
          });
        });
      }

      const DEFAULT_GROUP_COUNT = 5;

      function createDefaultState(id, customName) {
        const def = {
          tournamentId: id || 'default',
          auth: { loggedIn: false, role: 'guest', pin: DEFAULT_PIN },
          ui: { activeTab: 'setup', setupStep: 1, qr1GroupFilter: 'ALL', qr2PoolFilter: 'ALL', bracketOpen: false, checkInFilter: 'ALL', checkInSearch: '', checkInGroupFilter: 'ALL', checkInSkillMin: '', checkInSkillMax: '', playerCheckInMode: window.location.hash === '#checkin', selectedPlayerName: '', headToHeadOpponent: '', playerSearch: '' },
          checkIns: {},
          playerSkills: {},
          playerProfileIds: {},
          phase: 'setup', // setup | qr1 | qr2 | semis | finals | completed
          config: {
            name: customName || 'SBE Light Vs Dark Side Tournament',
            date: '2026-03-15',
            venue: 'Orange County Badminton Club',
            rules: '',
            numGroups: DEFAULT_GROUP_COUNT,
            rosterTarget: null,
            playersPerGroup: 6,
            matchesPerPlayer: 4,
            qr2MatchesPerPlayer: 4,
            pointsToWin: 21,
            deuceCap: 25,
            qr2PoolsCount: 2,
            poolAFinalFormat: 'bo3', // bo3 | single
            poolBFinalFormat: 'single',
            poolFinalFormats: { A: 'bo3', B: 'single' },
            ranking: {
              winPointsWeight: 20,
              winMarginWeight: 1,
              lossMarginWeight: 1,
              tiebreakers: ['wp', 'wins', 'pf', 'pa']
            }
          },
          groups: Array.from({ length: DEFAULT_GROUP_COUNT }, (_, index) => {
            const id = String.fromCharCode(65 + index);
            return { id, name: `Group ${id}`, leader: '', players: [] };
          }),
          qr1Matches: [],
          qr2Pools: { A: [], B: [] },
          qr2Matches: { A: [], B: [] },
          semis: { A: [], B: [] },
          finals: { A: null, B: null },
          sync: { apiUrl: '', syncKey: '', status: 'local', lastSynced: null }
        };
        return def;
      }

      function loadRegistry() {
        try {
          const raw = localStorage.getItem(REGISTRY_KEY);
          if (raw) {
            const reg = JSON.parse(raw);
            if (reg && reg.items && typeof reg.items === 'object') return reg;
          }
        } catch (e) {}
        // Migrate single-tournament storage if present
        let initial = createDefaultState('default');
        try {
          const oldRaw = localStorage.getItem(STORAGE_KEY);
          if (oldRaw) {
            const parsed = JSON.parse(oldRaw);
            if (parsed && parsed.config && Array.isArray(parsed.groups)) {
              initial = parsed;
              if (!initial.tournamentId) initial.tournamentId = 'default';
            }
          }
        } catch (e) {}
        return { activeId: initial.tournamentId || 'default', items: { [initial.tournamentId || 'default']: initial } };
      }

      function saveRegistry() {
        try {
          registry.items[state.tournamentId] = state;
          registry.activeId = state.tournamentId;
          localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {}
      }

      function normalizeTournamentState(parsed, idFallback) {
        if (!parsed.tournamentId) parsed.tournamentId = idFallback || 'default';
        if (!parsed.ui) parsed.ui = {};
        if (!Number.isInteger(parsed.ui.setupStep) || parsed.ui.setupStep < 1 || parsed.ui.setupStep > 5) parsed.ui.setupStep = 1;
        if (parsed.ui.selectedPlayerName === undefined) parsed.ui.selectedPlayerName = '';
        if (parsed.ui.headToHeadOpponent === undefined) parsed.ui.headToHeadOpponent = '';
        if (parsed.ui.playerSearch === undefined) parsed.ui.playerSearch = '';
        if (!parsed.checkIns) parsed.checkIns = {};
        if (!parsed.playerSkills) parsed.playerSkills = {};
        if (!parsed.playerProfileIds || typeof parsed.playerProfileIds !== 'object' || Array.isArray(parsed.playerProfileIds)) parsed.playerProfileIds = {};
        if (parsed.config.name === 'SoCal Badminton Club Tournament' || parsed.config.name === 'SoCal Badminton Club') {
          parsed.config.name = 'SBE Light Vs Dark Side Tournament';
        }
        if (!parsed.config.ranking) {
          parsed.config.ranking = { winPointsWeight: 20, winMarginWeight: 1, lossMarginWeight: 1, tiebreakers: ['wp', 'wins', 'pf', 'pa'] };
        }
        if (typeof parsed.config.rules !== 'string') parsed.config.rules = '';
        if (!parsed.sync) parsed.sync = { apiUrl: '', syncKey: '', status: 'local', lastSynced: null };
        if (window.location.hash === '#checkin') parsed.ui.playerCheckInMode = true;
        try {
          const params = new URLSearchParams(window.location.search);
          const apiParam = params.get('api');
          if (apiParam) parsed.sync.apiUrl = apiParam.replace(/\/+$/, '');
        } catch (e) {}
        return parsed;
      }

      let registry = loadRegistry();
      let state = loadState();
      let themeMode = loadTheme();

      function loadState() {
        let playerParam = '';
        try {
          const params = new URLSearchParams(window.location.search);
          const tParam = params.get('t');
          playerParam = params.get('player') || '';
          if (tParam && registry.items[tParam]) {
            registry.activeId = tParam;
          } else if (tParam && !registry.items[tParam]) {
            const created = createDefaultState(tParam, 'Tournament ' + tParam);
            registry.items[tParam] = created;
            registry.activeId = tParam;
          }
        } catch (e) {}
        const active = registry.items[registry.activeId] || Object.values(registry.items)[0] || createDefaultState('default');
        const normalized = normalizeTournamentState(active, active.tournamentId);
        normalized.ui.activeTab = getRequestedPage();
        normalized.ui.bracketOpen = false;
        if (normalized.auth.role === 'guest' && normalized.ui.activeTab === 'setup') normalized.ui.activeTab = 'dashboard';
        if (playerParam) {
          normalized.ui.activeTab = 'players';
          normalized.ui.selectedPlayerName = playerParam;
        }
        return normalized;
      }

      let syncTimer = null;
      let syncInFlight = null;
      let syncGeneration = 0;
      let scoreSaveInProgress = false;
      let checkInSaveInProgress = false;
      let playerData = { loaded: false, loading: false, error: '', tournaments: [], profiles: [] };
      let playerDataPromise = null;
      let tournamentCatalog = { loaded: false, loading: false, error: '', items: [] };
      let tournamentCatalogPromise = null;
      let remoteTournamentIds = null;
      let playerAccountProfile = null;
      let playerMustChangePassword = false;
      let playerInviteContext = null;
      let playerInviteError = '';
      let playerAuthError = '';
      let adminAuthError = '';
      let sessionExpiryTimer = null;
      let sessionActivityTimer = null;
      let sessionActivityInFlight = false;
      let sessionActivityQueued = false;
      let lastSessionActivityRequest = 0;
      let lastSessionActivityAt = 0;
      const expiredScoreDraftKey = 'sbe-expired-score-draft';
      let expiredScoreDraft = null;

      function preserveScoreDraft() {
        const entries = [...document.querySelectorAll('[data-score-input], [data-final-input]')]
          .filter(input => input.value !== input.defaultValue)
          .map(input => ({
            attribute: input.hasAttribute('data-score-input') ? 'data-score-input' : 'data-final-input',
            key: input.getAttribute(input.hasAttribute('data-score-input') ? 'data-score-input' : 'data-final-input'),
            value: input.value
          }));
        if (!entries.length) return true;
        expiredScoreDraft = { tournamentId: state.tournamentId, entries };
        try {
          sessionStorage.setItem(expiredScoreDraftKey, JSON.stringify(expiredScoreDraft));
          return true;
        } catch (err) {
          console.error('Could not persist unsaved score entries:', err);
          return false;
        }
      }

      function restoreScoreDraft() {
        if (!expiredScoreDraft) {
          try {
            expiredScoreDraft = JSON.parse(sessionStorage.getItem(expiredScoreDraftKey) || 'null');
          } catch (err) {
            console.error('Could not load unsaved score entries:', err);
            return;
          }
        }
        if (!expiredScoreDraft || expiredScoreDraft.tournamentId !== state.tournamentId ||
            !Array.isArray(expiredScoreDraft.entries)) return;
        const inputs = [...document.querySelectorAll('[data-score-input], [data-final-input]')];
        expiredScoreDraft.entries = expiredScoreDraft.entries.filter(entry => {
          const input = inputs.find(item => item.getAttribute(entry.attribute) === entry.key);
          if (!input) return true;
          input.value = entry.value;
          const details = input.closest('details');
          if (details) details.open = true;
          return false;
        });
        try {
          if (expiredScoreDraft.entries.length) sessionStorage.setItem(expiredScoreDraftKey, JSON.stringify(expiredScoreDraft));
          else {
            sessionStorage.removeItem(expiredScoreDraftKey);
            expiredScoreDraft = null;
          }
        } catch (err) {
          console.error('Could not update unsaved score entries:', err);
        }
      }

      function setSessionExpiry(expiresAt) {
        const deadline = Date.parse(expiresAt);
        if (!Number.isFinite(deadline)) throw new Error('Invalid session expiry returned by the backend');
        clearTimeout(sessionExpiryTimer);
        sessionExpiryTimer = setTimeout(checkSessionExpiry, Math.max(0, deadline - Date.now()));
      }

      function expireSession() {
        clearTimeout(sessionActivityTimer);
        clearTimeout(sessionExpiryTimer);
        sessionActivityQueued = false;
        clearTimeout(syncTimer);
        syncTimer = null;
        let scoreDraftPersisted = true;
        if (state.auth.role === 'player') clearPlayerAccountProfile();
        else if (state.auth.role === 'admin') scoreDraftPersisted = preserveScoreDraft();
        if (state.sync.status === 'pending' || state.sync.status === 'syncing') state.sync.status = 'error';
        state.auth.loggedIn = false;
        state.auth.role = 'guest';
        state.ui.playerCheckInMode = false;
        delete state.auth.localExpiresAt;
        saveRegistry();
        closeModal();
        render();
        showToast(scoreDraftPersisted
          ? 'Your session expired after inactivity. Sign in again.'
          : 'Your session expired. Unsaved scores are kept in this tab only; sign in without reloading.', 'error');
      }

      async function checkSessionExpiry() {
        if (!state.auth.loggedIn || !['admin', 'player'].includes(state.auth.role)) return;
        const role = state.auth.role;
        if (role === 'admin' && !usesAdminSession()) {
          if (Date.now() >= Number(state.auth.localExpiresAt || 0)) expireSession();
          else setSessionExpiry(new Date(state.auth.localExpiresAt).toISOString());
          return;
        }
        try {
          if (role === 'admin') await requestAdminSession('/api/admin-auth/me');
          else await requestPlayerApi('/api/player-auth/me');
        } catch (err) {
          if (state.auth.role !== role || !state.auth.loggedIn) return;
          if (err.status === 401) expireSession();
          else {
            console.error('Could not verify session expiry:', err);
            expireSession();
            showToast(`Could not verify session: ${err.message}`, 'error');
          }
        }
      }

      async function sendSessionActivity() {
        if (sessionActivityInFlight || !sessionActivityQueued || !state.auth.loggedIn ||
            !['admin', 'player'].includes(state.auth.role)) return;
        const role = state.auth.role;
        sessionActivityQueued = false;
        sessionActivityInFlight = true;
        lastSessionActivityRequest = Date.now();
        try {
          if (role === 'admin' && !usesAdminSession()) {
            if (Date.now() >= Number(state.auth.localExpiresAt || 0)) {
              expireSession();
              return;
            }
            state.auth.localExpiresAt = lastSessionActivityAt + 2 * 60 * 60 * 1000;
            setSessionExpiry(new Date(state.auth.localExpiresAt).toISOString());
            saveRegistry();
          } else if (role === 'admin') {
            await requestAdminSession('/api/admin-auth/activity', {
              method: 'POST',
              body: JSON.stringify({ idleMs: Math.max(0, Date.now() - lastSessionActivityAt) })
            });
          } else {
            await requestPlayerApi('/api/player-auth/activity', {
              method: 'POST', headers: { 'x-sbe-player-request': '1' },
              body: JSON.stringify({ idleMs: Math.max(0, Date.now() - lastSessionActivityAt) })
            });
          }
        } catch (err) {
          if (state.auth.role === role && state.auth.loggedIn) {
            if (err.status === 401) expireSession();
            else {
              console.error('Could not update session activity:', err);
              showToast(`Could not update session activity: ${err.message}`, 'error');
            }
          }
        } finally {
          sessionActivityInFlight = false;
          if (sessionActivityQueued) scheduleSessionActivity();
        }
      }

      function scheduleSessionActivity() {
        if (!state.auth.loggedIn || !['admin', 'player'].includes(state.auth.role)) return;
        clearTimeout(sessionActivityTimer);
        const delay = Math.max(0, 30000 - (Date.now() - lastSessionActivityRequest));
        sessionActivityTimer = setTimeout(sendSessionActivity, delay);
      }

      ['pointerdown', 'keydown', 'input', 'wheel'].forEach(type => {
        document.addEventListener(type, event => {
          if (event.isTrusted && state.auth.loggedIn && ['admin', 'player'].includes(state.auth.role)) {
            lastSessionActivityAt = Date.now();
            sessionActivityQueued = true;
            scheduleSessionActivity();
          }
        }, { passive: true });
      });

      function getSyncHeaders() {
        const headers = { 'Content-Type': 'application/json', 'x-sbe-admin-request': '1' };
        if (!usesAdminSession() && state.sync?.syncKey) headers['x-sync-key'] = state.sync.syncKey;
        return headers;
      }

      function getSyncApiUrl() {
        const configuredUrl = (state.sync?.apiUrl || '').trim().replace(/\/+$/, '');
        if (configuredUrl) {
          return configuredUrl.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configuredUrl)
            ? configuredUrl
            : '';
        }
        const isLocalOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(window.location.origin);
        if (isLocalOrigin && window.location.port === '8080') {
          return `${window.location.protocol}//${window.location.hostname}:3001`;
        }
        return window.location.protocol === 'https:' || isLocalOrigin ? window.location.origin : '';
      }

      function usesAdminSession() {
        const apiUrl = getSyncApiUrl();
        return Boolean(apiUrl && new URL(apiUrl).origin === window.location.origin);
      }

      async function requestAdminSession(path, options) {
        if (!usesAdminSession()) throw new Error('Admin sessions require the app and API to use the same origin');
        const response = await fetch(`${getSyncApiUrl()}${path}`, {
          credentials: 'same-origin',
          ...options,
          headers: { 'Content-Type': 'application/json', 'x-sbe-admin-request': '1' }
        });
        const result = await response.json();
        if (!response.ok) {
          const error = new Error(result.error || `Admin authentication failed (HTTP ${response.status})`);
          error.status = response.status;
          throw error;
        }
        if (result.expiresAt && ['/api/admin-auth/login', '/api/admin-auth/me', '/api/admin-auth/activity'].includes(path)) {
          setSessionExpiry(result.expiresAt);
        }
        return result;
      }

      function getPlayerAuthApiUrl() {
        const apiUrl = getSyncApiUrl();
        if (!apiUrl || new URL(apiUrl).origin !== window.location.origin) {
          throw new Error('Player login requires the app and API to use the same origin');
        }
        return apiUrl;
      }

      async function requestPlayerApi(path, options) {
        const response = await fetch(`${getPlayerAuthApiUrl()}${path}`, {
          credentials: 'same-origin',
          ...options,
          headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) }
        });
        let result;
        try {
          result = await response.json();
        } catch (_err) {
          throw new Error(`Unexpected response from player API (HTTP ${response.status})`);
        }
        if (!response.ok) {
          const error = new Error(result.error || `Player API request failed (HTTP ${response.status})`);
          error.status = response.status;
          throw error;
        }
        if (result.expiresAt && ['/api/player-auth/login', '/api/player-auth/register', '/api/player-auth/me', '/api/player-auth/activity'].includes(path)) {
          setSessionExpiry(result.expiresAt);
        }
        if (options?.method && options.method !== 'GET' &&
            !['/api/player-auth/login', '/api/player-auth/register', '/api/player-auth/logout', '/api/player-auth/activity'].includes(path)) {
          scheduleChangeRefresh();
        }
        return result;
      }

      function applyPlayerAccount(profile, mustChangePassword, activeTab) {
        playerAccountProfile = profile;
        playerMustChangePassword = Boolean(mustChangePassword);
        playerAuthError = '';
        playerInviteError = '';
        state.auth.loggedIn = true;
        state.auth.role = 'player';
        state.ui.activeTab = activeTab || (state.ui.activeTab === 'setup' ? 'tournaments' : state.ui.activeTab);
        state.ui.selectedPlayerName = profile.name;
        playerData.profiles = playerData.profiles.filter(item => !samePlayerIdentity(item, profile));
        playerData.profiles.push(profile);
        playerData.loaded = false;
        scheduleChangeRefresh();
      }

      function clearPlayerAccountProfile() {
        const accountProfile = playerAccountProfile;
        if (accountProfile) {
          playerData.profiles = playerData.profiles.filter(profile => !samePlayerIdentity(profile, accountProfile));
          try {
            const cached = JSON.parse(localStorage.getItem(PLAYER_PROFILES_KEY) || '[]');
            if (Array.isArray(cached)) {
              localStorage.setItem(PLAYER_PROFILES_KEY, JSON.stringify(
                cached.filter(profile => !samePlayerIdentity(profile, accountProfile))
              ));
            }
          } catch (_err) {
            console.error('Could not clear the cached player profile on logout');
          }
        }
        playerAccountProfile = null;
        playerMustChangePassword = false;
        playerData.loaded = false;
      }

      async function restorePlayerSession() {
        try {
          const result = await requestPlayerApi('/api/player-auth/me');
          applyPlayerAccount(result.player, result.mustChangePassword);
          return true;
        } catch (err) {
          if (err.status === 401 || /HTTP 401/.test(err.message)) {
            clearPlayerAccountProfile();
            state.auth.loggedIn = false;
            state.auth.role = 'guest';
            saveRegistry();
          } else {
            console.error('Could not restore player session:', err);
            playerAuthError = `Player session could not be restored: ${err.message}`;
            clearPlayerAccountProfile();
            state.auth.loggedIn = false;
            state.auth.role = 'guest';
            saveRegistry();
          }
          return false;
        }
      }

      async function loadPlayerInvite() {
        if (!playerInviteToken) return;
        state.auth.loggedIn = false;
        state.auth.role = 'guest';
        try {
          playerInviteContext = await requestPlayerApi(`/api/player-auth/invites/${encodeURIComponent(playerInviteToken)}`);
        } catch (err) {
          playerInviteError = err.message;
        }
      }

      function samePlayerIdentity(left, right) {
        const names = profile => [profile?.name, ...(Array.isArray(profile?.aliases) ? profile.aliases : [])]
          .map(name => window.PlayerAnalytics.normalizeName(name)).filter(Boolean);
        const leftNames = new Set(names(left));
        return names(right).some(name => leftNames.has(name));
      }

      function getOwnPlayerRosterEntry() {
        if (!playerAccountProfile) return null;
        return getAllImportedPlayers().find(player => {
          const linkedId = String(state.playerProfileIds?.[normalizeImportName(player.name)] || '').toLowerCase();
          const profileId = String(playerAccountProfile.playerId || '').toLowerCase();
          return (profileId && linkedId === profileId) || samePlayerIdentity(playerAccountProfile, { name: player.name });
        }) || null;
      }

      function cachePlayerProfile(profile) {
        const usedCodes = new Set(playerData.profiles.map(item => String(item.playerCode || '')).filter(Boolean));
        const savedProfile = {
          ...profile,
          playerId: profile.playerId || createUniqueId(),
          playerCode: profile.playerCode || createPlayerCode(usedCodes)
        };
        const profiles = playerData.profiles.filter(item =>
          !(profile.playerId && item.playerId === profile.playerId) && !samePlayerIdentity(item, profile)
        );
        profiles.push(savedProfile);
        playerData.profiles = profiles;
        playerData.loaded = !getSyncApiUrl();
        try {
          localStorage.setItem(PLAYER_PROFILES_KEY, JSON.stringify(profiles));
        } catch (_err) {
          showToast('Profile saved, but this browser could not cache it locally', 'error');
        }
        return savedProfile;
      }

      function getLocalPlayerProfiles() {
        try {
          const profiles = JSON.parse(localStorage.getItem(PLAYER_PROFILES_KEY) || '[]');
          const storedProfiles = Array.isArray(profiles) ? profiles.filter(profile => profile && typeof profile === 'object') : [];
          const usedIds = new Set();
          const usedCodes = new Set();
          let changed = !Array.isArray(profiles) || storedProfiles.length !== profiles.length;
          const localProfiles = storedProfiles.map(profile => {
            let playerId = String(profile.playerId || '').toLowerCase();
            if (!isValidPlayerId(playerId) || usedIds.has(playerId)) {
              playerId = createUniqueId();
              changed = true;
            }
            if (playerId !== profile.playerId) changed = true;
            usedIds.add(playerId);
            let playerCode = String(profile.playerCode || '');
            if (!/^\d{6}$/.test(playerCode) || usedCodes.has(playerCode)) {
              playerCode = createPlayerCode(usedCodes);
              changed = true;
            }
            usedCodes.add(playerCode);
            return { ...profile, playerId, playerCode };
          });
          const knownNames = new Set();
          localProfiles.forEach(profile => [profile.name, ...(Array.isArray(profile.aliases) ? profile.aliases : [])].forEach(name => {
            const key = normalizeImportName(name);
            if (key) knownNames.add(key);
          }));
          const addRosterProfile = name => {
            const cleanName = String(name || '').trim();
            const key = normalizeImportName(cleanName);
            if (!key || /^(TBD|Seed\s+\d+)$/i.test(cleanName) || isAnonymizedPlayerName(cleanName) || knownNames.has(key)) return;
            let playerId = createUniqueId();
            while (usedIds.has(playerId)) playerId = createUniqueId();
            usedIds.add(playerId);
            const playerCode = createPlayerCode(usedCodes);
            usedCodes.add(playerCode);
            knownNames.add(key);
            localProfiles.push({
              playerId,
              playerCode,
              name: cleanName,
              displayName: cleanName,
              aliases: [],
              photoUrl: '',
              age: null,
              nickname: '',
              gender: '',
              club: '',
              ranking: '',
              country: '',
              state: '',
              city: '',
              emergencyContact: '',
              playingHand: '',
              preferredEvents: [],
              email: '',
              visibility: {}
            });
            changed = true;
          };
          getLocalPlayerTournaments().forEach(tournament => {
            const data = tournament.data || {};
            (data.groups || []).forEach(group => (group.players || []).forEach(addRosterProfile));
            Object.values(data.qr2Pools || {}).forEach(pool => (pool || []).forEach(addRosterProfile));
          });
          if (changed) {
            try {
              localStorage.setItem(PLAYER_PROFILES_KEY, JSON.stringify(localProfiles));
            } catch (err) {
              console.error('Could not store player identifiers in this browser:', err);
              showToast('Player IDs were generated but could not be cached in this browser', 'error');
            }
          }
          return playerAccountProfile
            ? [...localProfiles.filter(profile => !samePlayerIdentity(profile, playerAccountProfile)), playerAccountProfile]
            : localProfiles;
        } catch (_err) {
          return [];
        }
      }

      function getLocalPlayerTournaments() {
        const tournaments = new Map();
        Object.values(registry.items || {}).forEach(tournament => {
          if (tournament && tournament.tournamentId) {
            tournaments.set(String(tournament.tournamentId), { id: String(tournament.tournamentId), data: tournament });
          }
        });
        if (state && state.tournamentId && !tournaments.has(String(state.tournamentId))) {
          tournaments.set(String(state.tournamentId), { id: String(state.tournamentId), data: state });
        }
        return [...tournaments.values()];
      }

      async function loadPlayerData(force) {
        if (playerData.loading) {
          await playerDataPromise;
          if (force) return loadPlayerData(true);
          return;
        }
        if (playerData.loaded && !force) return;
        playerData.loading = true;
        playerData.error = '';
        const localTournaments = getLocalPlayerTournaments();
        playerDataPromise = (async () => {
          const apiUrl = getSyncApiUrl();
          if (!apiUrl) {
            playerData.tournaments = localTournaments;
            playerData.profiles = getLocalPlayerProfiles();
            return;
          }
          try {
            const [historyResponse, ownAccount] = await Promise.all([
              fetch(`${apiUrl}/api/tournament-history/public`, { cache: 'no-store' }),
              state.auth.role === 'player' ? requestPlayerApi('/api/player-auth/me') : null
            ]);
            let historyJson = await historyResponse.json();
            if (!historyResponse.ok) throw new Error(historyJson.error || `History request failed (HTTP ${historyResponse.status})`);
            if (!Array.isArray(historyJson.tournaments) || !Array.isArray(historyJson.players)) {
              throw new Error('Invalid player directory response');
            }
            if (ownAccount) {
              const publicProfile = historyJson.players.find(profile => profile.playerId === ownAccount.player.playerId);
              if (!publicProfile || publicProfile.revision !== ownAccount.player.revision) {
                const snapshotResponse = await fetch(`${apiUrl}/api/tournament-history`, { cache: 'no-store' });
                historyJson = await snapshotResponse.json();
                if (!snapshotResponse.ok) throw new Error(historyJson.error || `History request failed (HTTP ${snapshotResponse.status})`);
                if (!Array.isArray(historyJson.tournaments) || !Array.isArray(historyJson.players) || !historyJson.ownPlayer) {
                  throw new Error('Player profile changed; reload the player directory');
                }
              } else {
                historyJson.ownPlayer = ownAccount.player;
              }
            }
            playerData.tournaments = historyJson.tournaments;
            if (state.auth.role === 'player' && historyJson.ownPlayer) playerAccountProfile = historyJson.ownPlayer;
            playerData.profiles = playerAccountProfile && state.auth.role === 'player'
              ? [...historyJson.players.filter(profile => profile.playerId !== playerAccountProfile.playerId), playerAccountProfile]
              : historyJson.players;
          } catch (err) {
            playerData.error = `Could not load current cloud player data: ${err.message}`;
          }
        })().finally(() => {
          playerData.loading = false;
          playerData.loaded = true;
          playerDataPromise = null;
        });
        return playerDataPromise;
      }

      function getLocalTournamentCatalog() {
        return Object.values(registry.items || {}).filter(tournament => !tournament.ui?.emptyTournament).map(tournament => ({
          id: String(tournament.tournamentId),
          name: tournament.config?.name || 'Tournament',
          date: tournament.config?.date || '',
          venue: tournament.config?.venue || '',
          phase: tournament.phase || 'setup',
          data: tournament,
          updatedAt: tournament.sync?.lastSynced || ''
        }));
      }

      async function loadTournamentCatalog(force) {
        if (tournamentCatalog.loading) return tournamentCatalogPromise;
        if (tournamentCatalog.loaded && !force) return;
        tournamentCatalog.loading = true;
        tournamentCatalog.error = '';
        const localTournaments = getLocalTournamentCatalog();
        tournamentCatalogPromise = (async () => {
          const apiUrl = getSyncApiUrl();
          if (!apiUrl) {
            tournamentCatalog.items = localTournaments;
            return;
          }
          try {
            const response = await fetch(`${apiUrl}/api/tournament-catalog`, { cache: 'no-store' });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || `Tournament history request failed (HTTP ${response.status})`);
            if (!Array.isArray(result.tournaments)) throw new Error('Invalid tournament history response');
            tournamentCatalog.items = result.tournaments.map(tournament => ({
              ...tournament,
              id: String(tournament.id),
              name: tournament.name || tournament.data?.config?.name || 'Tournament',
              date: tournament.date || tournament.data?.config?.date || '',
              venue: tournament.venue || tournament.data?.config?.venue || '',
              phase: tournament.phase || tournament.data?.phase || 'setup'
            }));
          } catch (err) {
            tournamentCatalog.error = `Cloud tournament history could not be loaded: ${err.message}`;
          }
        })().finally(() => {
          tournamentCatalog.loading = false;
          tournamentCatalog.loaded = true;
          tournamentCatalogPromise = null;
        });
        return tournamentCatalogPromise;
      }

      async function openTournamentFromCatalog(tournamentId) {
        const id = String(tournamentId || '');
        const tournament = tournamentCatalog.items.find(item => item.id === id);
        if (!tournament) {
          showToast('Tournament details are not available', 'error');
          return;
        }
        try {
          let data = tournament.data;
          let remoteRevision = null;
          let remoteUpdatedAt = null;
          const apiUrl = getSyncApiUrl();
          if (apiUrl) {
            const response = await fetch(`${apiUrl}/api/tournaments/${encodeURIComponent(id)}`);
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || `Tournament request failed (HTTP ${response.status})`);
            if (!result.exists || !result.data) throw new Error('Tournament no longer exists; refresh the list');
            data = result.data;
            remoteRevision = result.revision;
            remoteUpdatedAt = result.updatedAt;
          }
          if (!data || !data.config) throw new Error('Tournament data is incomplete');
          const previous = registry.items[id];
          const fresh = createDefaultState(id, tournament.name);
          const restored = normalizeTournamentState({
            ...data,
            tournamentId: id,
            phase: data.phase || tournament.phase || 'setup',
            auth: { ...state.auth },
            sync: {
              ...state.sync, ...(previous?.sync || {}),
              ...(remoteRevision ? { revision: remoteRevision, lastSynced: remoteUpdatedAt, status: 'synced' } : {})
            },
            ui: { ...fresh.ui, activeTab: 'dashboard' }
          }, id);
          registry.items[id] = restored;
          state = restored;
          window.history.replaceState(window.history.state, '', getPageUrl(getRequestedPage()));
          saveRegistry();
          if (apiUrl) await pullFromTurso(true);
          state.ui.activeTab = 'dashboard';
          await navigateToPage('dashboard');
        } catch (err) {
          showToast(`Could not open tournament: ${err.message}`, 'error');
        }
      }

      async function persistPlayerProfile(profile, current) {
        const apiUrl = getSyncApiUrl();
        const existing = current || playerData.profiles.find(item => samePlayerIdentity(item, profile));
        let savedProfile = {
          ...profile,
          playerId: profile.playerId || existing?.playerId || createUniqueId(),
          playerCode: profile.playerCode || existing?.playerCode || createPlayerCode(
            new Set(playerData.profiles.map(item => String(item.playerCode || '')).filter(Boolean))
          )
        };
        if (apiUrl) {
          const response = await fetch(`${apiUrl}/api/players/${encodeURIComponent(current?.name || profile.name)}`, {
            method: 'PUT',
            headers: { ...getSyncHeaders(), 'x-player-revision': current?.revision || 'new' },
            body: JSON.stringify(savedProfile)
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || `Profile save failed (HTTP ${response.status})`);
          savedProfile = result.player;
          scheduleChangeRefresh();
        }
        return cachePlayerProfile(savedProfile);
      }

      async function getPlayerImportDirectory() {
        const apiUrl = getSyncApiUrl();
        if (apiUrl) {
          const response = await fetch(`${apiUrl}/api/player-import/directory`, {
            credentials: 'same-origin',
            headers: getSyncHeaders()
          });
          let result;
          try { result = await response.json(); } catch (_err) {
            throw new Error(`Unexpected response from player directory (HTTP ${response.status})`);
          }
          if (!response.ok) throw new Error(result.error || `Player directory request failed (HTTP ${response.status})`);
          return {
            profiles: Array.isArray(result.profiles) ? result.profiles : [],
            rosterNames: Array.isArray(result.rosterNames) ? result.rosterNames : []
          };
        }

        const profiles = getLocalPlayerProfiles();
        const rosterNames = new Map();
        const addName = name => {
          const cleanName = String(name || '').trim();
          const key = normalizeImportName(cleanName);
          if (key && !rosterNames.has(key)) rosterNames.set(key, cleanName);
        };
        profiles.forEach(profile => addName(profile.name));
        getLocalPlayerTournaments().forEach(tournament => {
          const data = tournament.data || {};
          (data.groups || []).forEach(group => (group.players || []).forEach(addName));
          Object.values(data.qr2Pools || {}).forEach(pool => (pool || []).forEach(addName));
        });
        return { profiles, rosterNames: [...rosterNames.values()] };
      }

      async function getPlayerProfileDirectory() {
        const apiUrl = getSyncApiUrl();
        let profiles;
        if (apiUrl) {
          const response = await fetch(`${apiUrl}/api/player-import/directory`, { cache: 'no-store', headers: getSyncHeaders() });
          let result;
          try { result = await response.json(); } catch (_err) {
            throw new Error(`Unexpected response from player profiles (HTTP ${response.status})`);
          }
          if (!response.ok) throw new Error(result.error || `Player profiles request failed (HTTP ${response.status})`);
          if (!Array.isArray(result.profiles)) throw new Error('Invalid player directory response');
          profiles = result.profiles;
        } else {
          profiles = getLocalPlayerProfiles();
        }

        return profiles;
      }

      function addPlayerProfilesToGroup(groupIndex, profiles) {
        if (state.auth.role !== 'admin') return false;
        const group = state.groups[groupIndex];
        if (!group || !profiles.length || profiles.some(profile => !String(profile?.name || '').trim() || !isValidPlayerId(profile?.playerId))) {
          showToast('Choose player profiles with valid player IDs', 'error');
          return false;
        }
        for (let index = 0; index < profiles.length; index++) {
          const profile = profiles[index];
          if (isPlayerProfileInRoster(profile) || profiles.slice(0, index).some(other =>
            other.playerId === profile.playerId || samePlayerIdentity(other, profile))) {
            showToast(`${profile.displayName || profile.name} is already selected or in this tournament`, 'error');
            return false;
          }
        }

        profiles.forEach(profile => {
          const name = String(profile.name).trim();
          group.players.push(name);
          setPlayerSkill(name, profile.skill ?? 5);
          if (!group.leader) group.leader = name;
          [name, ...(Array.isArray(profile.aliases) ? profile.aliases : [])].forEach(alias => {
            const key = normalizeImportName(alias);
            if (key) state.playerProfileIds[key] = profile.playerId;
          });
        });
        saveState();
        render();
        showToast(`Added ${profiles.length} ${profiles.length === 1 ? 'player' : 'players'} to ${group.name}`, 'success');
        return true;
      }

      function addPlayerProfileToGroup(groupIndex, profile) {
        return addPlayerProfilesToGroup(groupIndex, [profile]);
      }

      function isPlayerProfileInRoster(profile) {
        return state.groups.some(group => group.players.some(name => {
          const linkedId = state.playerProfileIds[normalizeImportName(name)];
          return linkedId === profile.playerId || samePlayerIdentity(profile, { name });
        }));
      }

      async function pushToTurso(silent, localFallback = true, resettingMatches = false) {
        const apiUrl = getSyncApiUrl();
        if (!apiUrl) return true;
        if (syncInFlight) {
          await syncInFlight;
          if (state.sync.status === 'error') return false;
          if (state.sync.status === 'synced') return true;
        }
        const target = state;
        const generation = syncGeneration;
        const operation = (async () => {
        try {
          state.sync.status = 'syncing';
          const tid = encodeURIComponent(state.tournamentId || 'default');
          const payload = { ...state, auth: { ...state.auth, loggedIn: false }, ui: { ...state.ui, bracketOpen: false } };
          delete payload.sync;
          if (!state.sync.revision) throw new Error('Reload the tournament before saving');
          const res = await fetch(`${apiUrl}/api/tournaments/${tid}`, {
            method: 'PUT',
            headers: { ...getSyncHeaders(), 'x-tournament-revision': state.sync.revision },
            body: JSON.stringify({ data: payload })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          if (state !== target) return true;
          if (data.playerProfileIds && typeof data.playerProfileIds === 'object' && !Array.isArray(data.playerProfileIds)) {
            state.playerProfileIds = generation === syncGeneration ? data.playerProfileIds :
              { ...data.playerProfileIds, ...state.playerProfileIds };
          }
          state.sync.revision = data.revision;
          state.sync.status = generation === syncGeneration ? 'synced' : 'pending';
          state.sync.lastSynced = data.updatedAt || new Date().toISOString();
          saveRegistry();
          scheduleChangeRefresh();
          const badge = document.getElementById('sync-status-pill');
          if (badge) badge.textContent = state.sync.status === 'synced' ? 'Cloud Synced' : 'Sync Pending';
          if (!silent) showToast('Saved to Turso DB', 'success');
          return true;
        } catch (err) {
          target.sync.status = 'error';
          saveRegistry();
          const badge = document.getElementById('sync-status-pill');
          if (badge) badge.textContent = 'Sync Error';
          console.error('Cloud sync failed:', err);
          const message = /invalid (?:admin )?sync key/i.test(err.message)
              ? 'Admin sync key rejected. Enter the same ADMIN_SYNC_KEY configured in the backend Cloud Sync settings.'
              : localFallback
                ? `Cloud sync failed (${err.message}) — saved locally. Note your changes before using Cloud Sync → Pull from DB.`
                : `${resettingMatches ? 'Match reset could not be confirmed' : 'Tournament was not created'}: ${err.message}`;
          showToast(message, 'error');
          return false;
        }
        })();
        syncInFlight = operation;
        try { return await operation; } finally { syncInFlight = null; }
      }

      async function pullFromTurso(silent) {
        const apiUrl = getSyncApiUrl();
        if (!apiUrl) return;
        if (silent && (scoreSaveInProgress || checkInSaveInProgress || hasUnsavedScoreEntry() ||
            ['pending', 'syncing', 'error'].includes(state.sync.status))) {
          showToast('Local changes are not synced. Review Cloud Sync before reloading.', 'error');
          return;
        }
        const target = state;
        const generation = syncGeneration;
        const startingRevision = state.sync.revision;
        try {
          // Also fetch tournament list from Turso so switcher shows all DB tournaments
          try {
            const listRes = await fetch(`${apiUrl}/api/tournaments`);
            if (listRes.ok) {
              const listJson = await listRes.json();
              (listJson.tournaments || []).forEach(t => {
                if (!registry.items[t.id]) {
                  registry.items[t.id] = createDefaultState(t.id, t.name);
                  registry.items[t.id].config.date = t.date || registry.items[t.id].config.date;
                  registry.items[t.id].config.venue = t.venue || registry.items[t.id].config.venue;
                  registry.items[t.id].phase = t.phase || 'setup';
                  registry.items[t.id].sync = { ...state.sync, status: 'synced', revision: null, lastSynced: null, remoteListed: true };
                }
              });
            }
          } catch (e) {}

          const tid = encodeURIComponent(state.tournamentId || 'default');
          const res = await fetch(`${apiUrl}/api/tournaments/${tid}`);
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
          if (state !== target || syncGeneration !== generation || state.sync.revision !== startingRevision || scoreSaveInProgress || checkInSaveInProgress ||
              (silent && hasUnsavedScoreEntry())) return;
          if (json && json.exists && json.data) {
            const keepAuth = state.auth;
            const keepUi = state.ui;
            const keepSync = state.sync;
            state = normalizeTournamentState({ ...json.data, tournamentId: state.tournamentId, auth: keepAuth, ui: keepUi, sync: { ...keepSync, status: 'synced', revision: json.revision, lastSynced: json.updatedAt || new Date().toISOString() } }, state.tournamentId);
            upsertPlayerDataTournament(state.tournamentId, state, json.updatedAt);
            saveRegistry();
            render();
            if (!silent) showToast('Loaded tournament from Turso DB', 'success');
          } else {
            if ((startingRevision && startingRevision !== 'new') ||
                (startingRevision === null && target.sync.remoteListed)) {
              if (!silent) throw new Error('This tournament was deleted. Local changes have not been replaced.');
              await refreshTournamentList(true);
              return;
            }
            state.sync.status = 'synced';
            state.sync.revision = 'new';
            saveRegistry();
            if (!silent) showToast('Connected to Turso DB (new tournament — push to save)', 'success');
          }
        } catch (err) {
          state.sync.status = 'error';
          console.error('Could not pull tournament from backend:', err);
          if (!silent) showToast(`Could not load from backend (${err.message})`, 'error');
        }
      }

      let liveScoreRefreshInProgress = false;
      let liveScoreRefreshErrorLogged = false;
      function isEditingFormField() {
        return Boolean(document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName));
      }

      function hasUnsavedScoreEntry() {
        const scoreIsChanged = input => {
          const [listKey, id, side] = input.getAttribute('data-score-input').split(':');
          let matches = [];
          if (listKey === 'qr1') matches = state.qr1Matches;
          else if (listKey.startsWith('qr2_')) matches = state.qr2Matches[listKey.slice(4)] || [];
          else if (listKey.startsWith('semi_')) matches = state.semis[listKey.slice(5)] || [];
          const match = matches.find(item => item.id === id);
          const expected = match?.[`s${side}`];
          return input.value !== (expected === null || expected === undefined ? '' : String(expected));
        };
        const finalIsChanged = input => {
          const [groupKey, gameIndex, side] = input.getAttribute('data-final-input').split(':');
          const expected = state.finals[groupKey]?.games?.[Number(gameIndex)]?.[`s${side}`];
          return input.value !== (expected === null || expected === undefined ? '' : String(expected));
        };
        return [...document.querySelectorAll('[data-score-input]')].some(scoreIsChanged) ||
          [...document.querySelectorAll('[data-final-input]')].some(finalIsChanged);
      }

      async function refreshLiveScores() {
        if (liveScoreRefreshInProgress || scoreSaveInProgress || checkInSaveInProgress || document.visibilityState === 'hidden' || isEditingFormField() || hasUnsavedScoreEntry() ||
          state.sync?.status !== 'synced' || !state.sync.lastSynced) return null;
        const apiUrl = getSyncApiUrl();
        if (!apiUrl) return null;

        liveScoreRefreshInProgress = true;
        try {
          const tournamentId = String(state.tournamentId || 'default');
          const revision = state.sync.revision;
          const query = revision ? `?revision=${encodeURIComponent(revision)}` : '';
          const response = await fetch(
            `${apiUrl}/api/tournaments/${encodeURIComponent(tournamentId)}${query}`,
            { cache: 'no-store' }
          );
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || `Tournament refresh failed (HTTP ${response.status})`);
          if (state.tournamentId !== tournamentId || state.sync.revision !== revision || scoreSaveInProgress || checkInSaveInProgress ||
              state.sync.status !== 'synced' || isEditingFormField() || hasUnsavedScoreEntry()) return null;
          liveScoreRefreshErrorLogged = false;
          const badge = document.getElementById('sync-status-pill');
          if (badge) badge.textContent = 'Cloud Synced';
          if (!result.exists) {
            await refreshTournamentList(true);
            return null;
          }
          if (result.unchanged || !result.data) return true;

          const keepAuth = state.auth;
          const keepUi = state.ui;
          const keepSync = state.sync;
          state = normalizeTournamentState({
            ...result.data,
            tournamentId,
            auth: keepAuth,
            ui: keepUi,
            sync: {
              ...keepSync,
              status: 'synced',
              revision: result.revision,
              lastSynced: result.updatedAt || new Date().toISOString()
            }
          }, tournamentId);
          registry.items[tournamentId] = state;
          upsertPlayerDataTournament(tournamentId, state, result.updatedAt);
          tournamentCatalog.loaded = false;
          saveRegistry();
          render();
          return true;
        } catch (err) {
          if (!liveScoreRefreshErrorLogged) {
            console.error('Live score refresh failed:', err);
            const badge = document.getElementById('sync-status-pill');
            if (badge) badge.textContent = 'Live Update Error';
            liveScoreRefreshErrorLogged = true;
          }
          return false;
        } finally {
          liveScoreRefreshInProgress = false;
        }
      }

      let tournamentListRefreshInProgress = false;
      let tournamentListRefreshErrorLogged = false;
      let tournamentListRenderPending = false;
      let deletedTournamentNotice = '';

      async function refreshTournamentList(force = false) {
        if (tournamentListRefreshInProgress || !state.auth.loggedIn ||
            (!force && document.visibilityState === 'hidden')) return null;
        const apiUrl = getSyncApiUrl();
        if (!apiUrl) return null;
        const target = state;
        const generation = syncGeneration;
        tournamentListRefreshInProgress = true;
        try {
          const response = await fetch(`${apiUrl}/api/tournaments`, { cache: 'no-store' });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || `Tournament list request failed (HTTP ${response.status})`);
          if (!Array.isArray(result.tournaments)) throw new Error('Invalid tournament list response');
          if (state !== target || syncGeneration !== generation) return null;
          tournamentListRefreshErrorLogged = false;
          const remote = new Map(result.tournaments.map(tournament => [String(tournament.id), tournament]));
          const previousIds = remoteTournamentIds;
          remoteTournamentIds = new Set(remote.keys());
          let changed = !previousIds || previousIds.size !== remote.size ||
            [...previousIds].some(id => !remote.has(id));
          remote.forEach((tournament, id) => {
            if (registry.items[id]) return;
            const item = createDefaultState(id, tournament.name);
            item.config.date = tournament.date || item.config.date;
            item.config.venue = tournament.venue || item.config.venue;
            item.phase = tournament.phase || 'setup';
            item.sync = { ...target.sync, status: 'synced', revision: null, lastSynced: null, remoteListed: true };
            registry.items[id] = item;
            changed = true;
          });
          Object.entries(registry.items).forEach(([id, item]) => {
            if (id === String(target.tournamentId) || remote.has(id) || item.ui?.emptyTournament ||
                item.sync?.status !== 'synced' || item.sync?.revision === 'new') return;
            delete registry.items[id];
            changed = true;
          });

          const activeId = String(target.tournamentId);
          const deleted = !remote.has(activeId) && target.sync?.revision !== 'new' &&
            (target.sync?.revision || target.sync?.remoteListed);
          const modalOpen = !document.getElementById('modal-root').classList.contains('hidden');
          if (deleted) {
            const hasLocalChanges = ['pending', 'syncing', 'error'].includes(target.sync.status) ||
              scoreSaveInProgress || checkInSaveInProgress || isEditingFormField() || hasUnsavedScoreEntry() || modalOpen;
            if (hasLocalChanges) {
              if (deletedTournamentNotice !== activeId) {
                showToast('This tournament was deleted in another session. Your edits have not been replaced; copy them before leaving, as they cannot be synced to the deleted tournament.', 'error');
                deletedTournamentNotice = activeId;
              }
              return null;
            } else {
              const next = result.tournaments[0];
              let nextData;
              let nextRevision = 'new';
              let nextUpdatedAt = null;
              if (next) {
                const nextResponse = await fetch(`${apiUrl}/api/tournaments/${encodeURIComponent(next.id)}`, { cache: 'no-store' });
                const nextResult = await nextResponse.json();
                if (!nextResponse.ok) throw new Error(nextResult.error || `Tournament request failed (HTTP ${nextResponse.status})`);
                if (!nextResult.exists || !nextResult.data || !nextResult.revision) return null;
                nextData = nextResult.data;
                nextRevision = nextResult.revision;
                nextUpdatedAt = nextResult.updatedAt;
              } else {
                nextData = createDefaultState(`t_${createUniqueId()}`, 'New Tournament');
              }
              if (state !== target || syncGeneration !== generation || target.sync.status !== 'synced' ||
                  scoreSaveInProgress || checkInSaveInProgress || isEditingFormField() || hasUnsavedScoreEntry() ||
                  !document.getElementById('modal-root').classList.contains('hidden')) return null;
              const nextId = next ? String(next.id) : nextData.tournamentId;
              const nextUi = { ...target.ui };
              if (next) delete nextUi.emptyTournament;
              else nextUi.emptyTournament = true;
              state = normalizeTournamentState({
                ...nextData, tournamentId: nextId, auth: target.auth, ui: nextUi,
                sync: { ...target.sync, status: 'synced', revision: nextRevision, lastSynced: nextUpdatedAt }
              }, nextId);
              delete registry.items[activeId];
              registry.items[nextId] = state;
              playerData.loaded = false;
              playerData.tournaments = playerData.tournaments.filter(tournament =>
                String(tournament.id || tournament.tournamentId) !== activeId
              );
              window.history.replaceState(window.history.state, '', getPageUrl(getRequestedPage()));
              deletedTournamentNotice = '';
              changed = true;
              render();
              showToast('The selected tournament was deleted in another session.', 'error');
            }
          } else {
            deletedTournamentNotice = '';
          }
          if (changed) {
            saveRegistry();
            tournamentListRenderPending = true;
          }
          if (tournamentListRenderPending && !isEditingFormField() && !hasUnsavedScoreEntry() &&
              !scoreSaveInProgress && !checkInSaveInProgress && !modalOpen) {
            tournamentListRenderPending = false;
            render();
          }

          if (tournamentListRenderPending ||
              (state.ui.activeTab === 'tournaments' &&
               (tournamentCatalog.loading || isEditingFormField() || modalOpen))) return null;
          if (state.ui.activeTab === 'tournaments' && !tournamentCatalog.loading &&
              !isEditingFormField() && !modalOpen) {
            const before = JSON.stringify([tournamentCatalog.items, tournamentCatalog.error]);
            await loadTournamentCatalog(true);
            if (state.ui.activeTab === 'tournaments' &&
                before !== JSON.stringify([tournamentCatalog.items, tournamentCatalog.error])) render();
            if (tournamentCatalog.error) return false;
          }
          return true;
        } catch (err) {
          if (!tournamentListRefreshErrorLogged) {
            console.error('Tournament list refresh failed:', err);
            showToast(`Could not refresh tournaments: ${err.message}`, 'error');
            tournamentListRefreshErrorLogged = true;
          }
          return false;
        } finally {
          tournamentListRefreshInProgress = false;
        }
      }

      function applyCheckInResult(result, tournamentId) {
        if (state.tournamentId !== tournamentId || !result.data || !result.revision) {
          throw new Error('Check-in was saved, but the tournament must be reloaded');
        }
        state = normalizeTournamentState({
          ...result.data, tournamentId, auth: state.auth, ui: state.ui,
          sync: { ...state.sync, status: 'synced', revision: result.revision, lastSynced: result.updatedAt }
        }, tournamentId);
        tournamentCatalog.loaded = false;
        upsertPlayerDataTournament(tournamentId, state, result.updatedAt);
        saveRegistry();
        scheduleChangeRefresh();
      }

      async function syncCheckInToServer(playerName, checkedIn, source, checkedInAt) {
        const apiUrl = getSyncApiUrl();
        const time = checkedInAt || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (!apiUrl) {
          if (!state.checkIns) state.checkIns = {};
          if (checkedIn) state.checkIns[playerName] = { checkedIn: true, time, source };
          else delete state.checkIns[playerName];
          saveState();
          return;
        }
        if (checkInSaveInProgress || scoreSaveInProgress) throw new Error('Wait for the current save to finish');
        checkInSaveInProgress = true;
        const app = document.getElementById('app');
        app.inert = true;
        try {
          if (state.sync.status === 'error') throw new Error('Resolve the tournament sync error before checking in');
          if (syncTimer || syncInFlight || state.sync.status === 'pending' || state.sync.revision === 'new') {
            do {
              clearTimeout(syncTimer);
              syncTimer = null;
              if (!await pushToTurso(true)) throw new Error('Tournament changes could not be synced');
            } while (state.sync.status === 'pending');
          }
          if (state.sync.status !== 'synced' || !state.sync.revision) {
            throw new Error('Reload the tournament before checking in');
          }
          const tournamentId = state.tournamentId;
          const group = state.groups.find(item => item.players.includes(playerName));
          const response = await fetch(`${apiUrl}/api/tournaments/${encodeURIComponent(tournamentId)}/checkin`, {
            method: 'POST',
            headers: getSyncHeaders(),
            body: JSON.stringify({
              playerName, groupName: group?.name || null, skill: getPlayerSkill(playerName), checkedIn, time, source,
              playerId: state.playerProfileIds?.[normalizeImportName(playerName)] || ''
            })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || `Check-in sync failed (HTTP ${response.status})`);
          applyCheckInResult(result, tournamentId);
        } finally {
          checkInSaveInProgress = false;
          app.inert = false;
        }
      }

      async function switchTournament(id) {
        tournamentCatalog.loaded = false;
        if (state.auth.role === 'admin' && getSyncApiUrl() &&
            (syncTimer || syncInFlight || state.sync.status === 'pending')) {
          do {
            clearTimeout(syncTimer);
            syncTimer = null;
            if (!await pushToTurso(true)) {
              const switcher = document.getElementById('tournament-switcher');
              if (switcher) switcher.value = state.tournamentId;
              return;
            }
          } while (state.sync.status === 'pending');
        }
        saveRegistry();
        const next = registry.items[id];
        if (!next) return;
        const keepAuth = state.auth;
        const keepSync = state.sync;
        state = normalizeTournamentState({ ...next, auth: keepAuth, sync: { ...keepSync, ...(next.sync || {}), apiUrl: keepSync.apiUrl, syncKey: keepSync.syncKey, remoteListed: Boolean(next.sync?.remoteListed) } }, id);
        state.ui.activeTab = getRequestedPage();
        if (state.auth.role === 'guest' && state.ui.activeTab === 'setup') state.ui.activeTab = 'dashboard';
        window.history.replaceState(window.history.state, '', getPageUrl(getRequestedPage()));
        saveRegistry();
        render();
        scheduleChangeRefresh();
        if (getSyncApiUrl()) {
          pullFromTurso(true);
        }
      }

      async function getOpenTournaments() {
        const apiUrl = getSyncApiUrl();
        const local = getLocalTournamentCatalog();
        if (!apiUrl) return local.filter(tournament => tournament.phase !== 'completed');
        const response = await fetch(`${apiUrl}/api/tournaments`, { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        if (!Array.isArray(result.tournaments)) throw new Error('Invalid tournament list from backend');
        const remote = new Map(result.tournaments.map(tournament => [String(tournament.id), tournament]));
        const open = new Map([...remote.values()]
          .filter(tournament => tournament.phase !== 'completed')
          .map(tournament => [String(tournament.id), tournament]));
        local.forEach(tournament => {
          const localState = tournament.data;
          if (tournament.phase !== 'completed' &&
              ['pending', 'syncing', 'error'].includes(localState.sync?.status)) {
            open.set(tournament.id, tournament);
          }
        });
        return [...open.values()];
      }

      async function closeTournament(id) {
        const local = registry.items[id];
        const isCurrent = String(state.tournamentId) === String(id);
        if (local && ['pending', 'syncing'].includes(local.sync?.status)) {
          if (!isCurrent) throw new Error('Open this tournament and sync its local changes before closing it');
          clearTimeout(syncTimer);
          syncTimer = null;
          if (!await pushToTurso(true)) throw new Error('Sync local changes before closing this tournament');
          if (state.sync.status !== 'synced') throw new Error('Wait for local changes to sync before closing this tournament');
        }
        if (local?.sync?.status === 'error') throw new Error('Resolve the tournament sync error before closing it');
        const apiUrl = getSyncApiUrl();
        let data = local;
        let sync = local?.sync || state.sync;
        if (apiUrl) {
          const url = `${apiUrl}/api/tournaments/${encodeURIComponent(id)}`;
          const response = await fetch(url, { cache: 'no-store' });
          const current = await response.json();
          if (!response.ok) throw new Error(current.error || `HTTP ${response.status}`);
          if (current.exists) {
            data = { ...current.data, phase: 'completed', closedEarly: true };
            const saved = await fetch(url, {
              method: 'PUT',
              headers: { ...getSyncHeaders(), 'x-tournament-revision': current.revision },
              body: JSON.stringify({ data })
            });
            const result = await saved.json();
            if (!saved.ok) throw new Error(result.error || `HTTP ${saved.status}`);
            data.playerProfileIds = result.playerProfileIds;
            sync = { ...sync, status: 'synced', revision: result.revision, lastSynced: result.updatedAt };
          } else if (!data) {
            throw new Error('Tournament no longer exists; refresh the list');
          }
        }
        if (!data) throw new Error('Tournament no longer exists; refresh the list');
        data = { ...data, phase: 'completed', closedEarly: true };
        const fresh = createDefaultState(id, data.config?.name);
        const closed = normalizeTournamentState({
          ...data, tournamentId: id, auth: isCurrent ? state.auth : (local?.auth || state.auth),
          ui: isCurrent ? state.ui : (local?.ui || fresh.ui), sync
        }, id);
        registry.items[id] = closed;
        if (isCurrent) state = closed;
        tournamentCatalog.loaded = false;
        upsertPlayerDataTournament(id, closed, sync.lastSynced);
        saveRegistry();
        render();
        scheduleChangeRefresh();
      }

      async function createNewTournament(name, date, venue) {
        tournamentCatalog.loaded = false;
        if (getSyncApiUrl() && (syncTimer || syncInFlight || state.sync.status === 'pending')) {
          do {
            clearTimeout(syncTimer);
            syncTimer = null;
            if (!await pushToTurso(true)) return false;
          } while (state.sync.status === 'pending');
        }
        saveRegistry();
        const previous = state;
        const id = `t_${createUniqueId()}`;
        const fresh = createDefaultState(id, name || 'New Badminton Tournament');
        if (date) fresh.config.date = date;
        if (venue) fresh.config.venue = venue;
        fresh.auth = { ...state.auth };
        fresh.sync = { ...state.sync, status: getSyncApiUrl() ? 'synced' : 'local' };
        fresh.sync.revision = 'new';
        fresh.sync.lastSynced = null;
        fresh.ui.activeTab = state.auth.role === 'admin' ? 'setup' : 'dashboard';
        registry.items[id] = fresh;
        state = fresh;
        saveRegistry();
        if (getSyncApiUrl() && !await pushToTurso(true, false)) {
          delete registry.items[id];
          state = previous;
          saveRegistry();
          render();
          return false;
        }
        if (previous.ui?.emptyTournament ||
            (getSyncApiUrl() && previous.sync?.revision === 'new' && previous.sync?.status === 'synced')) {
          delete registry.items[previous.tournamentId];
        }
        saveRegistry();
        await navigateToPage(state.ui.activeTab);
        render();
        return true;
      }

      async function deleteTournament(id) {
        const tournamentId = String(id || '');
        const availableIds = new Set([
          ...Object.keys(registry.items),
          ...tournamentCatalog.items.map(tournament => String(tournament.id)),
          String(state.tournamentId)
        ]);
        if (!tournamentId || !availableIds.has(tournamentId)) {
          throw new Error('Tournament is no longer available');
        }
        const remainingIds = [...availableIds].filter(candidate => candidate !== tournamentId);
        const wasActive = tournamentId === String(state.tournamentId);
        const apiUrl = getSyncApiUrl();
        if (wasActive) {
          clearTimeout(syncTimer);
          syncTimer = null;
          if (syncInFlight) await syncInFlight;
        }
        if (apiUrl) {
          const response = await fetch(`${apiUrl}/api/tournaments/${encodeURIComponent(tournamentId)}`, {
            method: 'DELETE',
            headers: getSyncHeaders()
          });
          let result;
          try { result = await response.json(); } catch (_err) {
            throw new Error(`Unexpected response while deleting the tournament (HTTP ${response.status})`);
          }
          if (!response.ok) throw new Error(result.error || `Tournament deletion failed (HTTP ${response.status})`);
        }

        const nextId = Object.keys(registry.items).find(candidate => candidate !== tournamentId) || remainingIds[0];
        const nextTournament = tournamentCatalog.items.find(tournament => String(tournament.id) === nextId);
        delete registry.items[tournamentId];
        tournamentCatalog.items = tournamentCatalog.items.filter(tournament => String(tournament.id) !== tournamentId);
        tournamentCatalog.loaded = true;
        tournamentCatalog.error = '';
        playerData.tournaments = playerData.tournaments.filter(tournament =>
          String(tournament.id || tournament.tournamentId) !== tournamentId
        );

        if (wasActive) {
          const nextState = nextId
            ? registry.items[nextId] || nextTournament?.data || createDefaultState(nextId, nextTournament?.name)
            : createDefaultState(`t_${createUniqueId()}`, 'New Tournament');
          if (!nextId) nextState.ui.emptyTournament = true;
          const keepAuth = state.auth;
          const keepSync = state.sync;
          state = normalizeTournamentState({
            ...nextState,
            tournamentId: nextId || nextState.tournamentId,
            auth: keepAuth,
            sync: nextId ? { ...keepSync, ...(nextState.sync || {}) } :
              { ...keepSync, status: apiUrl ? 'synced' : 'local', revision: 'new', lastSynced: null },
            ui: { ...(nextState.ui || {}), activeTab: getRequestedPage() }
          }, nextId || nextState.tournamentId);
          registry.items[state.tournamentId] = state;
          window.history.replaceState(window.history.state, '', getPageUrl(getRequestedPage()));
        }
        saveRegistry();
        render();
        scheduleChangeRefresh();
        if (wasActive && apiUrl && nextId) await pullFromTurso(true);
        showToast('Tournament deleted', 'success');
      }

      function confirmTournamentDeletion(id, name, onDeleted) {
        openModal(`
          <div role="alertdialog" aria-modal="true" aria-labelledby="delete-tournament-title" class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-red-300 dark:border-red-900/60 p-6 space-y-4">
            <h3 id="delete-tournament-title" class="text-base font-bold">Delete tournament permanently?</h3>
            <p class="text-sm text-stone-600 dark:text-stone-300">"${esc(name)}" and all of its matches, check-ins, and player match-history/stats will be permanently removed. Shared player profiles will remain.</p>
            <div class="flex justify-end gap-2">
              <button id="delete-tournament-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-sm font-medium">Cancel</button>
              <button id="delete-tournament-confirm" type="button" class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-bold">Permanently delete</button>
            </div>
          </div>
        `);
        document.getElementById('delete-tournament-cancel').addEventListener('click', closeModal);
        const confirmButton = document.getElementById('delete-tournament-confirm');
        confirmButton.addEventListener('click', async () => {
          confirmButton.disabled = true;
          confirmButton.textContent = 'Deleting…';
          try {
            await deleteTournament(id);
            closeModal();
            if (onDeleted) await onDeleted();
          } catch (err) {
            confirmButton.disabled = false;
            confirmButton.textContent = 'Permanently delete';
            showToast(`Could not delete tournament: ${err.message}`, 'error');
          }
        });
      }

      function saveState() {
        delete state.ui.emptyTournament;
        syncGeneration++;
        tournamentCatalog.loaded = false;
        const apiUrl = getSyncApiUrl();
        if (apiUrl) state.sync.status = 'pending';
        saveRegistry();
        if (playerData.loaded && !apiUrl) {
          const tournaments = new Map(playerData.tournaments.map(tournament => [String(tournament.id || tournament.tournamentId), tournament]));
          tournaments.set(String(state.tournamentId), { id: String(state.tournamentId), data: state });
          playerData.tournaments = [...tournaments.values()];
        }
        if (apiUrl) {
          clearTimeout(syncTimer);
          syncTimer = setTimeout(() => { syncTimer = null; pushToTurso(true); }, 600);
        }
      }

      function upsertPlayerDataTournament(id, data, updatedAt) {
        if (!playerData.loaded) return;
        if (getSyncApiUrl()) {
          playerData.loaded = false;
          return;
        }
        const key = String(id);
        const tournaments = new Map(playerData.tournaments.map(tournament => [String(tournament.id || tournament.tournamentId), tournament]));
        const current = tournaments.get(key) || {};
        tournaments.set(key, {
          ...current,
          id: key,
          name: data.config?.name || current.name || 'Tournament',
          date: data.config?.date || current.date || '',
          phase: data.phase || current.phase || 'setup',
          data,
          updatedAt: updatedAt || current.updatedAt || ''
        });
        playerData.tournaments = [...tournaments.values()];
      }

      function loadTheme() {
        try {
          return localStorage.getItem(THEME_KEY) || 'dark';
        } catch (e) {
          return 'dark';
        }
      }

      function applyTheme(mode) {
        themeMode = mode;
        try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
        const root = document.documentElement;
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDark = mode === 'dark' || (mode === 'system' && prefersDark);
        root.classList.toggle('dark', isDark);
      }

      applyTheme(themeMode);

      function showToast(message, type) {
        const container = document.getElementById('toast-container');
        const el = document.createElement('div');
        const colors = type === 'error'
          ? 'bg-red-600 text-white'
          : type === 'success'
            ? 'bg-emerald-600 text-white'
            : 'bg-stone-800 text-white dark:bg-stone-200 dark:text-stone-900';
        el.className = `pointer-events-auto px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium transition-all duration-200 ${colors}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
          el.classList.add('opacity-0', 'translate-y-1');
          setTimeout(() => el.remove(), 220);
        }, 2800);
      }

      function openModal(html) {
        const root = document.getElementById('modal-root');
        root.innerHTML = html;
        root.classList.remove('hidden');
        root.classList.add('flex');
      }

      function closeModal() {
        const root = document.getElementById('modal-root');
        root.classList.add('hidden');
        root.classList.remove('flex');
        root.innerHTML = '';
      }

      function esc(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      const POOL_ACCENTS = {
        A: 'text-gold-600 dark:text-gold-400',
        B: 'text-purple-600 dark:text-purple-400',
        C: 'text-sky-600 dark:text-sky-400',
        D: 'text-emerald-600 dark:text-emerald-400',
        E: 'text-rose-600 dark:text-rose-400',
        F: 'text-orange-600 dark:text-orange-400'
      };
      function getPoolAccent(poolKey) {
        return POOL_ACCENTS[poolKey] || 'text-gold-600 dark:text-gold-400';
      }
      function getConfiguredPoolKeys() {
        const count = Math.max(2, Math.min(6, Number(state.config.qr2PoolsCount) || 2));
        return 'ABCDEF'.slice(0, count).split('');
      }
      function getActiveQR2PoolKeys() {
        const keys = Object.keys(state.qr2Pools || {}).filter(k => (state.qr2Pools[k] && state.qr2Pools[k].length > 0) || (state.qr2Matches[k] && state.qr2Matches[k].length > 0));
        return keys.length > 0 ? keys : Object.keys(state.qr2Pools || { A: [], B: [] });
      }

      function getPoolFinalFormat(poolKey) {
        if (poolKey === 'A' && (state.config.poolAFinalFormat === 'bo3' || state.config.poolAFinalFormat === 'single')) {
          return state.config.poolAFinalFormat;
        }
        if (poolKey === 'B' && (state.config.poolBFinalFormat === 'bo3' || state.config.poolBFinalFormat === 'single')) {
          return state.config.poolBFinalFormat;
        }
        const configuredFormat = state.config.poolFinalFormats?.[poolKey];
        if (configuredFormat === 'bo3' || configuredFormat === 'single') return configuredFormat;
        return 'single';
      }

      const TIEBREAKER_LABELS = {
        wp: 'Win Points (WP)',
        wins: 'Most Wins',
        pf: 'Points For (PF)',
        pa: 'Fewest Points Against (PA)',
        diff: 'Point Differential (PF-PA)'
      };
      function getRankingFormulaText() {
        const rk = state.config.ranking || { winPointsWeight: 20, winMarginWeight: 1, lossMarginWeight: 1 };
        return `WP = Wins × ${rk.winPointsWeight} + (${rk.winMarginWeight} × win margins) − (${rk.lossMarginWeight} × loss margins)`;
      }
      function getTiebreakerText() {
        const order = state.config.ranking?.tiebreakers || ['wp', 'wins', 'pf', 'pa'];
        return order.map(k => TIEBREAKER_LABELS[k] || k).join(' → ');
      }
      function buildQR2Schedules(pools) {
        const schedules = {};
        const duplicate = getDuplicateGroupPlayer(pools);
        if (duplicate !== null) {
          showToast(`Round 2: each player must appear in only one group (${duplicate})`, 'error');
          return null;
        }
        for (const [key, players] of Object.entries(pools)) {
          try {
            schedules[key] = TournamentDraw.generateGroupSchedule(
              players, state.config.qr2MatchesPerPlayer ?? state.config.matchesPerPlayer, `Pool${key}`, `QR2${key}`
            );
          } catch (err) {
            if (!(err instanceof RangeError)) throw err;
            showToast(`Round 2 Group ${key}: ${err.message}`, 'error');
            return null;
          }
        }
        return schedules;
      }

      function getDuplicateGroupPlayer(groups) {
        const seen = new Set();
        for (const players of Object.values(groups)) {
          for (const player of players) {
            const name = normalizeImportName(player);
            if (!name || seen.has(name)) return player;
            seen.add(name);
          }
        }
        return null;
      }

      function getRound1SetupError() {
        for (const group of state.groups) {
          try {
            TournamentDraw.validateGroupPlayers(group.players, state.config.matchesPerPlayer);
          } catch (err) {
            if (!(err instanceof RangeError)) throw err;
            return `Round 1 ${group.name} (${group.players.length} players): ${err.message}.`;
          }
        }
        const duplicate = getDuplicateGroupPlayer(Object.fromEntries(state.groups.map(group => [group.id, group.players])));
        if (duplicate !== null) return `Round 1: each player must appear in only one group (${duplicate}).`;
        return '';
      }

      function getRound2SetupError() {
        const total = state.groups.reduce((sum, group) => sum + group.players.length, 0);
        const keys = getConfiguredPoolKeys();
        const baseSize = Math.floor(total / keys.length);
        if (baseSize < 8) return '';
        for (let index = 0; index < keys.length; index++) {
          const size = baseSize + (index < total % keys.length ? 1 : 0);
          try {
            TournamentDraw.validateGroupMatchCount(size, state.config.qr2MatchesPerPlayer ?? state.config.matchesPerPlayer);
          } catch (err) {
            if (!(err instanceof RangeError)) throw err;
            return `Round 2 Group ${keys[index]} (${size} players): ${err.message}.`;
          }
        }
        return '';
      }

      function isValidSingleScore(s1, s2, pointsToWin, deuceCap) {
        if (!Number.isInteger(s1) || !Number.isInteger(s2) || s1 < 0 || s2 < 0) return false;
        if (s1 === s2) return false;
        const hi = Math.max(s1, s2);
        const lo = Math.min(s1, s2);
        if (hi < pointsToWin || hi > deuceCap) return false;
        if (hi === pointsToWin && hi - lo >= 2) return true;
        if (hi > pointsToWin && hi < deuceCap && hi - lo === 2) return true;
        if (hi === deuceCap && hi - lo >= 1) return true;
        return false;
      }

      // Ranking formula: WP = Wins * 20 + sum(win margins) - sum(loss margins)
      function computeStandings(players, matches, wpFirst = false) {
        return window.PlayerAnalytics.computeStandings(players, matches, state.config.ranking, wpFirst);
      }

      function randomValidScore() {
        const win = state.config.pointsToWin;
        const cap = state.config.deuceCap;
        const p1Wins = Math.random() > 0.5;
        let hi = win;
        let lo = Math.floor(Math.random() * (win - 3));
        if (Math.random() < 0.18) {
          lo = win - 1;
          hi = Math.min(cap, win + 1);
          if (hi === cap && Math.random() > 0.5) lo = cap - 1;
        }
        return p1Wins ? [hi, lo] : [lo, hi];
      }

      // Actions
      async function loginAdmin(password) {
        if (usesAdminSession()) {
          try {
            await requestAdminSession('/api/admin-auth/login', {
              method: 'POST',
              body: JSON.stringify({ password })
            });
          } catch (err) {
            adminAuthError = err.message;
            render();
            return;
          }
        } else if (password !== state.auth.pin) {
          showToast('Incorrect Admin PIN', 'error');
          return;
        } else {
          state.auth.localExpiresAt = Date.now() + 2 * 60 * 60 * 1000;
          setSessionExpiry(new Date(state.auth.localExpiresAt).toISOString());
        }
        adminAuthError = '';
        if (usesAdminSession()) {
          Object.values(registry.items).forEach(tournament => {
            if (tournament.sync) tournament.sync.syncKey = '';
          });
          state.sync.syncKey = '';
        }
        state.auth.loggedIn = true;
        state.auth.role = 'admin';
        saveRegistry();
        render();
        scheduleChangeRefresh();
        showToast('Signed in as Admin', 'success');
      }

      function loginGuest() {
        state.auth.loggedIn = true;
        state.auth.role = 'guest';
        if (state.ui.activeTab === 'setup') {
          state.ui.activeTab = state.phase === 'setup' ? 'dashboard' : state.phase;
        }
        saveRegistry();
        scheduleChangeRefresh();
        if (state.ui.activeTab !== getRequestedPage()) {
          window.location.replace(getPageUrl(state.ui.activeTab));
          return;
        }
        render();
      }

      async function logout() {
        if (state.auth.role === 'admin' && scoreSaveInProgress) {
          showToast('Wait for the score to finish saving before signing out', 'error');
          return;
        }
        if (state.auth.role === 'admin' && getSyncApiUrl() &&
            (syncTimer || syncInFlight || state.sync.status === 'pending')) {
          clearTimeout(syncTimer);
          syncTimer = null;
          do {
            if (!await pushToTurso(true)) return;
          } while (state.sync.status === 'pending');
        }
        if (state.auth.role === 'admin' && usesAdminSession()) {
          try {
            await requestAdminSession('/api/admin-auth/logout', { method: 'POST' });
          } catch (err) {
            showToast(`Could not end the admin session: ${err.message}`, 'error');
            return;
          }
        }
        state.auth.loggedIn = false;
        saveRegistry();
        render();
      }

      function sortGroupsByName() {
        state.groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      }

      function syncGroupCount(newCount, rerender) {
        const count = Math.max(2, Math.min(8, newCount));
        state.config.numGroups = count;
        const letters = 'ABCDEFGH'.split('');
        while (state.groups.length < count) {
          const usedIds = new Set(state.groups.map(g => g.id));
          const usedNames = new Set(state.groups.map(g => g.name.trim().toLowerCase()));
          const id = letters.find(l => !usedIds.has(l) && !usedNames.has(`group ${l.toLowerCase()}`))
            || letters.find(l => !usedIds.has(l))
            || String(state.groups.length + 1);
          let name = `Group ${id}`;
          let suffix = 2;
          while (usedNames.has(name.toLowerCase())) {
            name = `Group ${id} (${suffix++})`;
          }
          state.groups.push({ id, name, leader: '', players: [] });
        }
        if (state.groups.length > count) {
          state.groups = state.groups.slice(0, count);
        }
        sortGroupsByName();
        saveState();
        if (rerender !== false) render();
      }

      async function startTournament() {
        if (state.auth.role !== 'admin') return;
        if (state.phase === 'completed') {
          const target = state;
          try {
            if ((await getOpenTournaments()).some(tournament => String(tournament.id) !== String(state.tournamentId))) {
              showToast('Close or delete the open tournament before reopening this tournament', 'error');
              return;
            }
          } catch (err) {
            showToast(`Could not check open tournaments: ${err.message}`, 'error');
            return;
          }
          if (state !== target) return;
        }
        const round1Error = getRound1SetupError();
        if (round1Error) {
          showToast(round1Error, 'error');
          return;
        }
        const round2Error = getRound2SetupError();
        if (round2Error) {
          showToast(round2Error, 'error');
          return;
        }
        for (const g of state.groups) {
          if (g.players.length < 4) {
            showToast(`${g.name} needs at least 4 players`, 'error');
            return;
          }
          if (!g.leader || !g.players.includes(g.leader)) {
            showToast(`${g.name} needs a designated leader`, 'error');
            return;
          }
        }
        const qr1 = [];
        for (const g of state.groups) {
          try {
            qr1.push(...TournamentDraw.generateGroupSchedule(g.players, state.config.matchesPerPlayer, g.id, 'QR1'));
          } catch (err) {
            if (!(err instanceof RangeError)) throw err;
            showToast(`Round 1 ${g.name}: ${err.message}`, 'error');
            return;
          }
        }
        state.qr1Matches = qr1;
        state.qr2Pools = { A: [], B: [] };
        state.qr2Matches = { A: [], B: [] };
        state.semis = { A: [], B: [] };
        state.finals = { A: null, B: null };
        state.phase = 'qr1';
        delete state.closedEarly;
        state.ui.activeTab = 'qr1';
        state.ui.qr1GroupFilter = 'ALL';
        saveState();
        navigateToPage('qr1');
      }

      function advanceToQR2() {
        if (Object.values(state.qr2Pools || {}).some(players => players.length)) {
          showToast('Round 2 schedules already exist', 'error');
          return;
        }
        if (!state.qr1Matches.length || state.qr1Matches.some(m => !m.completed)) {
          showToast('Complete all QR1 matches before advancing', 'error');
          return;
        }
        const poolKeys = getConfiguredPoolKeys();
        const allPlayers = state.groups.flatMap(group => group.players);
        const rankings = computeStandings(allPlayers, state.qr1Matches);
        if (rankings.length < poolKeys.length * 8) {
          showToast('Each Round 2 group needs at least 8 players for its semi-final bracket', 'error');
          return;
        }
        const pools = TournamentDraw.groupRankedPlayers(
          rankings.map(row => row.player),
          poolKeys.length
        );

        const matches = buildQR2Schedules(pools);
        if (!matches) return;
        state.qr2Pools = pools;
        state.qr2Matches = matches;
        state.phase = 'qr2';
        state.ui.activeTab = 'qr2';
        saveState();
        navigateToPage('qr2');
      }

      function addQR2Pool(poolKey, playerNames, sourcePools) {
        const pools = { ...(sourcePools || {}), [poolKey]: playerNames };
        const duplicate = getDuplicateGroupPlayer({ ...state.qr2Pools, ...pools });
        if (duplicate !== null) {
          showToast(`Round 2: each player must appear in only one group (${duplicate})`, 'error');
          return false;
        }
        const schedules = buildQR2Schedules(pools);
        if (!schedules) return false;
        Object.assign(state.qr2Pools, pools);
        Object.assign(state.qr2Matches, schedules);
        state.config.qr2PoolsCount = Math.max(Number(state.config.qr2PoolsCount) || 2, Object.keys(state.qr2Pools).length);
        saveState();
        render();
        return true;
      }

      function advanceToSemis() {
        const poolKeys = getActiveQR2PoolKeys().filter(k => (state.qr2Pools[k] || []).length > 0);
        if (!poolKeys.length) {
          showToast('Create Round 2 groups before advancing', 'error');
          return;
        }
        if (poolKeys.some(key => (state.qr2Pools[key] || []).length < 8)) {
          showToast('Each Round 2 group needs at least 8 players to advance its top 8 to semi-finals', 'error');
          return;
        }
        const allDone = poolKeys.every(k => (state.qr2Matches[k] || []).length > 0 && state.qr2Matches[k].every(m => m.completed));
        if (!allDone) {
          showToast('Complete all QR2 matches across all pools first', 'error');
          return;
        }
        const buildPoolSemis = (poolKey) => {
          const standings = computeStandings(state.qr2Pools[poolKey] || [], state.qr2Matches[poolKey] || []);
          const slots = Math.min(8, standings.length);
          const top = standings.slice(0, slots).map(r => r.player);
          if (top.length >= 8) {
            const teams = TournamentDraw.drawSemiFinalPartners(top.slice(0, 8))
              .map(team => team.join(' & '));
            return [
              { id: `SF-${poolKey}-1`, pool: poolKey, label: 'Semi-Final 1', t1: teams[0], t2: teams[3], s1: null, s2: null, completed: false, round: 1, court: 1 },
              { id: `SF-${poolKey}-2`, pool: poolKey, label: 'Semi-Final 2', t1: teams[1], t2: teams[2], s1: null, s2: null, completed: false, round: 1, court: 2 }
            ];
          } else if (top.length >= 4) {
            return [
              { id: `SF-${poolKey}-1`, pool: poolKey, label: 'Semi-Final 1', t1: top[0], t2: top[3], s1: null, s2: null, completed: false, round: 1, court: 1 },
              { id: `SF-${poolKey}-2`, pool: poolKey, label: 'Semi-Final 2', t1: top[1], t2: top[2], s1: null, s2: null, completed: false, round: 1, court: 2 }
            ];
          } else {
            return [
              { id: `SF-${poolKey}-1`, pool: poolKey, label: 'Semi-Final 1', t1: top[0] || 'Seed 1', t2: top[1] || 'Seed 2', s1: null, s2: null, completed: false, round: 1, court: 1 }
            ];
          }
        };
        const missingPools = poolKeys.filter(k => !(state.semis[k] || []).length);
        if (!missingPools.length) {
          showToast('Semi-final schedules already exist', 'error');
          return;
        }
        missingPools.forEach(k => { state.semis[k] = buildPoolSemis(k); });
        state.phase = 'semis';
        state.ui.activeTab = 'semis';
        saveState();
        navigateToPage('semis');
      }

      function advanceToFinals() {
        const poolKeys = getActiveQR2PoolKeys().filter(k => (state.qr2Pools[k] || []).length > 0);
        const allDone = poolKeys.length > 0 && poolKeys.every(k =>
          (state.semis[k] || []).length >= 2 && state.semis[k].every(m => m.completed)
        );
        if (!allDone) {
          showToast('Complete all Semi-Final matches first', 'error');
          return;
        }
        const getWinner = (m) => (m.s1 > m.s2 ? m.t1 : m.t2);
        const makeFinal = (poolKey, format) => {
          const ms = state.semis[poolKey] || [];
          const t1 = ms[0] ? getWinner(ms[0]) : 'TBD';
          const t2 = ms[1] ? getWinner(ms[1]) : 'TBD';
          return {
            id: `FINAL-${poolKey}`,
            pool: poolKey,
            format,
            t1,
            t2,
            games: format === 'bo3' ? [{ s1: null, s2: null }, { s1: null, s2: null }, { s1: null, s2: null }] : [{ s1: null, s2: null }],
            completed: false,
            winner: null
          };
        };
        const missingPools = poolKeys.filter(k => !state.finals[k]);
        if (!missingPools.length) {
          showToast('Final schedules already exist', 'error');
          return;
        }
        missingPools.forEach(k => { state.finals[k] = makeFinal(k, getPoolFinalFormat(k)); });
        state.phase = 'finals';
        state.ui.activeTab = 'finals';
        saveState();
        navigateToPage('finals');
      }

      function simulateMatches(list) {
        list.forEach(m => {
          if (!m.completed) {
            const [s1, s2] = randomValidScore();
            m.s1 = s1; m.s2 = s2; m.completed = true; m.completedAt = new Date().toISOString();
          }
        });
        saveState();
        render();
        showToast('Simulated remaining matches', 'success');
      }

      function confirmScoreCorrection(listKey, save, isCurrent) {
        let affected = '';
        let reset;
        if (listKey === 'qr1' && Object.values(state.qr2Pools || {}).some(players => players.length)) {
          affected = 'all Round 2, semi-final, and final schedules and scores';
          reset = () => {
            state.qr2Pools = { A: [], B: [] };
            state.qr2Matches = { A: [], B: [] };
            state.semis = { A: [], B: [] };
            state.finals = { A: null, B: null };
            state.phase = 'qr1';
          };
        } else if (listKey.startsWith('qr2_')) {
          const key = listKey.slice(4);
          if ((state.semis[key] || []).length || state.finals[key]) {
            affected = `Group ${key}'s semi-final and final schedules and scores`;
            reset = () => {
              delete state.semis[key];
              delete state.finals[key];
              state.phase = 'qr2';
            };
          }
        } else if (listKey.startsWith('semi_')) {
          const key = listKey.slice(5);
          if (state.finals[key]) {
            affected = `Group ${key}'s final schedule and scores`;
            reset = () => {
              delete state.finals[key];
              state.phase = 'semis';
            };
          }
        }
        if (!reset) {
          save(null);
          return;
        }
        if (!getSyncApiUrl() && state.phase === 'completed' && getLocalTournamentCatalog()
          .some(tournament => tournament.id !== String(state.tournamentId) && tournament.phase !== 'completed')) {
          showToast('Close or delete the open tournament before reopening this tournament', 'error');
          return;
        }
        const confirmedRevision = state.sync.revision;
        openModal(`
          <div class="w-full max-w-lg rounded-2xl bg-white dark:bg-[#191B1F] border border-red-300 dark:border-red-900/60 p-6 space-y-4">
            <h3 class="text-base font-bold">Change this score?</h3>
            <p class="text-xs text-stone-500">This will permanently clear ${esc(affected)}. You will need to advance again to generate the affected schedules. Other groups' later results are preserved when possible.</p>
            <div class="flex justify-end gap-2">
              <button id="score-correction-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button id="score-correction-confirm" type="button" class="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-bold">Clear and save score</button>
            </div>
          </div>
        `);
        document.getElementById('score-correction-cancel').addEventListener('click', closeModal);
        document.getElementById('score-correction-confirm').addEventListener('click', () => {
          if (!isCurrent()) {
            closeModal();
            render();
            showToast('The tournament changed; review the score and try again', 'error');
            return;
          }
          if (!getSyncApiUrl()) {
            reset();
            delete state.closedEarly;
          }
          closeModal();
          save(confirmedRevision);
        });
      }

      async function saveMatchScore(listKey, id, expectedMatch, score, confirmedRevision) {
        if (state.sync.status !== 'synced' || !state.sync.revision || state.sync.revision === 'new') {
          showToast('Sync or reload the tournament before saving a score', 'error');
          return false;
        }
        if (scoreSaveInProgress) {
          showToast('Wait for the current score to save', 'error');
          return false;
        }
        const tournamentId = state.tournamentId;
        const previousRevision = state.sync.revision;
        let conflict = false;
        scoreSaveInProgress = true;
        const app = document.getElementById('app');
        app.inert = true;
        try {
          const response = await fetch(`${getSyncApiUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(id)}/score`, {
            method: 'PATCH',
            headers: getSyncHeaders(),
            body: JSON.stringify({ listKey, expectedMatch, ...score, confirmedRevision })
          });
          const result = await response.json();
          if (!response.ok) {
            conflict = response.status === 409;
            throw new Error(result.error || `HTTP ${response.status}`);
          }
          if (state.tournamentId !== tournamentId || state.sync.revision !== previousRevision || state.sync.status !== 'synced') {
            throw new Error('Tournament changed locally; reload before making further changes');
          }
          const inputValues = new Map();
          let staleDraft = false;
          document.querySelectorAll('[data-score-input], [data-final-input]').forEach(input => {
            const attr = input.hasAttribute('data-score-input') ? 'data-score-input' : 'data-final-input';
            const key = input.getAttribute(attr);
            if ((attr === 'data-score-input' && key.startsWith(`${listKey}:${id}:`)) ||
                (attr === 'data-final-input' && listKey === `final_${key.split(':')[0]}`)) return;
            const parts = key.split(':');
            let before, after, expected;
            if (attr === 'data-final-input') {
              before = state.finals[parts[0]];
              after = result.data.finals?.[parts[0]];
              expected = before?.games?.[Number(parts[1])]?.[`s${parts[2]}`];
            } else {
              const find = (tournament) => {
                const list = parts[0] === 'qr1' ? tournament.qr1Matches :
                  parts[0].startsWith('qr2_') ? tournament.qr2Matches?.[parts[0].slice(4)] :
                    tournament.semis?.[parts[0].slice(5)];
                return list?.find(match => match.id === parts[1]);
              };
              before = find(state);
              after = find(result.data);
              expected = before?.[`s${parts[2]}`];
            }
            if (input.value !== (expected == null ? '' : String(expected))) {
              inputValues.set(`${attr}|${key}`, input.value);
              if (JSON.stringify(before) !== JSON.stringify(after)) staleDraft = true;
            }
          });
          if (staleDraft) {
            state.sync.status = 'error';
            const badge = document.getElementById('sync-status-pill');
            if (badge) badge.textContent = 'Sync Error';
            showToast('Score saved, but another edited match changed remotely. Note unsaved scores, then use Cloud Sync → Pull from DB.', 'error');
            return false;
          }
          const keepAuth = state.auth, keepUi = state.ui, keepSync = state.sync;
          state = normalizeTournamentState({
            ...result.data, tournamentId, auth: keepAuth, ui: keepUi,
            sync: { ...keepSync, status: 'synced', revision: result.revision, lastSynced: result.updatedAt }
          }, tournamentId);
          tournamentCatalog.loaded = false;
          upsertPlayerDataTournament(tournamentId, state, result.updatedAt);
          saveRegistry();
          render();
          scheduleChangeRefresh();
          document.querySelectorAll('[data-score-input], [data-final-input]').forEach(input => {
            const attr = input.hasAttribute('data-score-input') ? 'data-score-input' : 'data-final-input';
            const key = `${attr}|${input.getAttribute(attr)}`;
            if (inputValues.has(key)) input.value = inputValues.get(key);
          });
          return true;
        } catch (err) {
          console.error('Score save failed:', err);
          if (conflict) {
            state.sync.status = 'error';
            const badge = document.getElementById('sync-status-pill');
            if (badge) badge.textContent = 'Sync Error';
          }
          showToast(`Score save failed or could not be confirmed: ${err.message}`, 'error');
          return false;
        } finally {
          app.inert = false;
          scoreSaveInProgress = false;
        }
      }

      // Compute overall KPIs
      function getStatsSummary() {
        const totalPlayers = state.groups.reduce((sum, g) => sum + g.players.length, 0);
        const qr1Total = state.qr1Matches.length;
        const qr1Done = state.qr1Matches.filter(m => m.completed).length;
        const allQr2 = Object.values(state.qr2Matches || {}).flat();
        const qr2Total = allQr2.length;
        const qr2Done = allQr2.filter(m => m.completed).length;
        const allSemis = Object.values(state.semis || {}).flat();
        const semiTotal = allSemis.length;
        const semiDone = allSemis.filter(m => m.completed).length;
        const allFinals = Object.values(state.finals || {}).filter(Boolean);
        const finalTotal = allFinals.length;
        const finalDone = allFinals.filter(f => f.completed).length;
        const total = qr1Total + qr2Total + semiTotal + finalTotal;
        const done = qr1Done + qr2Done + semiDone + finalDone;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return { totalPlayers, qr1Total, qr1Done, qr2Total, qr2Done, semiTotal, semiDone, finalTotal, finalDone, total, done, pct };
      }

      function getPlayerSkill(name) {
        const val = Number(state.playerSkills?.[name]);
        return Number.isFinite(val) && val >= 1 && val <= 10 ? Math.round(val) : 5;
      }

      function setPlayerSkill(name, val) {
        if (!state.playerSkills) state.playerSkills = {};
        const clamped = Math.max(1, Math.min(10, Math.round(Number(val) || 5)));
        state.playerSkills[name] = clamped;
      }

      function getAllImportedPlayers() {
        const list = [];
        state.groups.forEach((g, gi) => {
          g.players.forEach((p, pi) => {
            list.push({ name: p, group: g.name, groupIndex: gi, playerIndex: pi, isLeader: g.leader === p });
          });
        });
        return list;
      }

      function renamePlayerEverywhere(gi, pi, rawNewName) {
        const oldName = state.groups[gi].players[pi];
        const newName = (rawNewName || '').trim();
        if (!newName || newName === oldName) return false;
        if (newName.includes('&')) {
          showToast('Player names cannot contain & in doubles schedules', 'error');
          return false;
        }
        state.groups[gi].players[pi] = newName;
        if (state.groups[gi].leader === oldName) state.groups[gi].leader = newName;
        if (state.playerSkills && state.playerSkills[oldName] !== undefined) {
          state.playerSkills[newName] = state.playerSkills[oldName];
          delete state.playerSkills[oldName];
        }
        if (state.checkIns && state.checkIns[oldName]) {
          state.checkIns[newName] = state.checkIns[oldName];
          delete state.checkIns[oldName];
        }
        const replaceTeamName = (str) => {
          if (!str) return str;
          if (str === oldName) return newName;
          return str.split(' & ').map(part => part === oldName ? newName : part).join(' & ');
        };
        (state.qr1Matches || []).forEach(m => {
          m.p1 = replaceTeamName(m.p1);
          m.p2 = replaceTeamName(m.p2);
        });
        Object.keys(state.qr2Pools || {}).forEach(k => {
          state.qr2Pools[k] = (state.qr2Pools[k] || []).map(p => p === oldName ? newName : p);
        });
        Object.keys(state.qr2Matches || {}).forEach(k => {
          (state.qr2Matches[k] || []).forEach(m => {
            m.p1 = replaceTeamName(m.p1);
            m.p2 = replaceTeamName(m.p2);
          });
        });
        Object.keys(state.semis || {}).forEach(k => {
          (state.semis[k] || []).forEach(m => {
            m.t1 = replaceTeamName(m.t1);
            m.t2 = replaceTeamName(m.t2);
          });
        });
        Object.keys(state.finals || {}).forEach(k => {
          const f = state.finals[k];
          if (!f) return;
          f.t1 = replaceTeamName(f.t1);
          f.t2 = replaceTeamName(f.t2);
          f.winner = replaceTeamName(f.winner);
        });
        return true;
      }

      window.addEventListener('hashchange', () => {
        if (window.location.hash === '#checkin') {
          state.ui.playerCheckInMode = true;
          render();
        }
      });

      // Renderers
      function render() {
        const app = document.getElementById('app');
        const openStandings = new Set(
          [...app.querySelectorAll('details[data-standings][open]')].map(details => details.dataset.standings)
        );
        const openMatches = new Set(
          [...app.querySelectorAll('details[data-match][open]')].map(details => details.dataset.match)
        );
        if (state.auth.role === 'player' && playerMustChangePassword) {
          app.innerHTML = renderRequiredPasswordChange();
          bindRequiredPasswordChange();
          return;
        }
        if (state.ui.playerCheckInMode) {
          app.innerHTML = renderPlayerCheckInScreen();
          if (state.auth.role === 'admin') bindPlayerCheckInEvents();
          else bindReadOnlyPlayerCheckInEvents();
          return;
        }
        if (!state.auth.loggedIn) {
          app.innerHTML = renderLoginScreen();
          bindLoginEvents();
          return;
        }
        app.innerHTML = `
          ${renderHeader()}
          ${renderNavTabs()}
          <main class="max-w-7xl mx-auto px-4 sm:px-6 py-6 ${state.auth.role === 'player' ? 'player-read-only' : ''}">
            ${renderActiveView()}
          </main>
          ${state.ui.bracketOpen ? renderBracketOverlay() : ''}
        `;
        app.querySelectorAll('details[data-standings]').forEach(details => {
          details.open = openStandings.has(details.dataset.standings);
        });
        app.querySelectorAll('details[data-match]').forEach(details => {
          details.open = openMatches.has(details.dataset.match);
        });
        if (state.auth.role === 'player') {
          applyPlayerReadOnlyControls();
          bindPlayerAppEvents();
        } else {
          bindAppEvents();
          if (state.auth.role === 'admin') restoreScoreDraft();
        }
      }

      function renderRequiredPasswordChange() {
        return `
          <main class="min-h-screen flex items-center justify-center p-4">
            <section class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 shadow-xl p-6 space-y-4">
              <div>
                <h1 class="text-lg font-bold">Choose a new password</h1>
                <p class="mt-1 text-xs text-stone-500">Your administrator reset your password. Change the temporary password before continuing.</p>
              </div>
              <form id="required-password-change-form" class="space-y-3">
                <label class="block text-xs font-semibold text-stone-500">Temporary password
                  <input id="required-current-password" type="password" required autocomplete="current-password" class="mt-1 w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
                </label>
                <label class="block text-xs font-semibold text-stone-500">New password (12–128 characters)
                  <input id="required-new-password" type="password" minlength="12" maxlength="128" required autocomplete="new-password" class="mt-1 w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
                </label>
                <label class="block text-xs font-semibold text-stone-500">Confirm new password
                  <input id="required-confirm-password" type="password" minlength="12" maxlength="128" required autocomplete="new-password" class="mt-1 w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
                </label>
                <p id="required-password-error" role="alert" class="hidden text-xs text-red-600 dark:text-red-400"></p>
                <div class="flex justify-between gap-2">
                  <button id="required-password-logout" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Log out</button>
                  <button type="submit" class="px-4 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Change password</button>
                </div>
              </form>
            </section>
          </main>
        `;
      }

      function bindRequiredPasswordChange() {
        bindPlayerPasswordChangeForm({
          formId: 'required-password-change-form',
          currentId: 'required-current-password',
          newId: 'required-new-password',
          confirmId: 'required-confirm-password',
          errorId: 'required-password-error',
          forced: true
        });
        document.getElementById('required-password-logout').addEventListener('click', async () => {
          try {
            await requestPlayerApi('/api/player-auth/logout', { method: 'POST' });
          } catch (err) {
            showToast(`Could not end the player session: ${err.message}`, 'error');
          }
          clearPlayerAccountProfile();
          state.auth.loggedIn = false;
          state.auth.role = 'guest';
          saveRegistry();
          render();
        });
      }

      function openPlayerPasswordChangeModal() {
        openModal(`
          <form id="player-password-change-form" class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
            <div>
              <h3 class="text-base font-bold">Change password</h3>
              <p class="mt-1 text-xs text-stone-500">Use a password between 12 and 128 characters.</p>
            </div>
            <label class="block text-xs font-semibold text-stone-500">Current password
              <input id="player-current-password" type="password" required autocomplete="current-password" class="mt-1 w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
            </label>
            <label class="block text-xs font-semibold text-stone-500">New password
              <input id="player-new-password" type="password" minlength="12" maxlength="128" required autocomplete="new-password" class="mt-1 w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
            </label>
            <label class="block text-xs font-semibold text-stone-500">Confirm new password
              <input id="player-confirm-password" type="password" minlength="12" maxlength="128" required autocomplete="new-password" class="mt-1 w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
            </label>
            <p id="player-password-error" role="alert" class="hidden text-xs text-red-600 dark:text-red-400"></p>
            <div class="flex justify-end gap-2">
              <button id="player-password-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button type="submit" class="px-4 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Update password</button>
            </div>
          </form>
        `);
        document.getElementById('player-password-cancel').addEventListener('click', closeModal);
        bindPlayerPasswordChangeForm({
          formId: 'player-password-change-form',
          currentId: 'player-current-password',
          newId: 'player-new-password',
          confirmId: 'player-confirm-password',
          errorId: 'player-password-error',
          forced: false
        });
      }

      function bindPlayerPasswordChangeForm(fields) {
        document.getElementById(fields.formId).addEventListener('submit', async event => {
          event.preventDefault();
          const currentPassword = document.getElementById(fields.currentId).value;
          const newPassword = document.getElementById(fields.newId).value;
          const error = document.getElementById(fields.errorId);
          if (newPassword !== document.getElementById(fields.confirmId).value) {
            error.textContent = 'Passwords do not match';
            error.classList.remove('hidden');
            return;
          }
          const submit = event.currentTarget.querySelector('button[type="submit"]');
          submit.disabled = true;
          error.classList.add('hidden');
          try {
            await requestPlayerApi('/api/player-auth/me/password', {
              method: 'PUT',
              body: JSON.stringify({ currentPassword, newPassword })
            });
            playerMustChangePassword = false;
            if (!fields.forced) closeModal();
            render();
            showToast('Password changed successfully', 'success');
          } catch (err) {
            error.textContent = err.message;
            error.classList.remove('hidden');
            submit.disabled = false;
          }
        });
      }

      async function requestAdminApi(path, options) {
        const apiUrl = getSyncApiUrl();
        if (!apiUrl) throw new Error('Configure the backend API URL before managing player accounts');
        const response = await fetch(`${apiUrl}${path}`, {
          credentials: 'same-origin',
          ...options,
          headers: { ...getSyncHeaders(), ...(options?.headers || {}) }
        });
        let result;
        try {
          result = await response.json();
        } catch (_err) {
          throw new Error(`Unexpected response from player account API (HTTP ${response.status})`);
        }
        if (!response.ok) throw new Error(result.error || `Player account API request failed (HTTP ${response.status})`);
        if (options?.method && options.method !== 'GET') scheduleChangeRefresh();
        return result;
      }

      function anonymizeLocalTournamentState(tournament, deletedPlayer, anonymizedName) {
        const identityNames = new Set([
          deletedPlayer.name,
          deletedPlayer.nickname,
          ...(Array.isArray(deletedPlayer.aliases) ? deletedPlayer.aliases : [])
        ].map(normalizeImportName).filter(Boolean));
        const playerId = String(deletedPlayer.playerId || '').toLowerCase();
        const anonymizeName = value => {
          const parts = String(value).split(/\s*&\s*/);
          let changed = false;
          const anonymizedParts = parts.map(part => {
            if (!identityNames.has(normalizeImportName(part))) return part;
            changed = true;
            return anonymizedName;
          });
          return changed ? anonymizedParts.join(' & ') : value;
        };
        const redact = value => {
          if (Array.isArray(value)) return value.map(redact);
          if (value && typeof value === 'object') {
            const result = {};
            Object.entries(value).forEach(([key, item]) => {
              if (key === 'playerProfileIds') {
                result[key] = Object.fromEntries(
                  Object.entries(item && typeof item === 'object' && !Array.isArray(item) ? item : {})
                    .filter(([name, id]) =>
                      !identityNames.has(normalizeImportName(name)) &&
                      (!playerId || String(id || '').toLowerCase() !== playerId)
                    )
                );
                return;
              }
              if (['checkIns', 'playerSkills'].includes(key) && item && typeof item === 'object' && !Array.isArray(item)) {
                result[key] = Object.fromEntries(
                  Object.entries(item)
                    .filter(([name]) => !identityNames.has(normalizeImportName(name)))
                    .map(([name, entry]) => [name, redact(entry)])
                );
                return;
              }
              const anonymizedKey = identityNames.has(normalizeImportName(key)) ? anonymizedName : key;
              if (playerId && typeof item === 'string' && item.toLowerCase() === playerId) {
                result[anonymizedKey] = '';
                return;
              }
              result[anonymizedKey] = redact(item);
            });
            return result;
          }
          if (typeof value !== 'string') return value;
          if (playerId && value.toLowerCase() === playerId) return '';
          return anonymizeName(value);
        };
        return redact(tournament);
      }

      function removeCachedPlayerProfile(profile) {
        const matchesDeletedPlayer = item =>
          profile.playerId && item.playerId
            ? item.playerId === profile.playerId
            : samePlayerIdentity(item, profile);
        playerData.profiles = playerData.profiles.filter(item => !matchesDeletedPlayer(item));
        try {
          const cached = JSON.parse(localStorage.getItem(PLAYER_PROFILES_KEY) || '[]');
          if (Array.isArray(cached)) {
            localStorage.setItem(PLAYER_PROFILES_KEY, JSON.stringify(cached.filter(item => !matchesDeletedPlayer(item))));
          }
          return true;
        } catch (err) {
          console.error('Could not remove the deleted player from the local profile cache:', err);
          return false;
        }
      }

      function refreshLocalTournamentStates(updatedTournamentIds, deletedPlayer, anonymizedName) {
        if (hasUnsyncedPlayerDeletionChanges()) {
          throw new Error('Local tournament changes are unsynced; resolve them before refreshing history');
        }
        const updatedIds = new Set((updatedTournamentIds || []).map(String));
        for (const [id, tournament] of Object.entries(registry.items || {})) {
          if (updatedIds.has(String(id)) && tournament.sync?.status !== 'synced') {
            throw new Error('A local tournament has not been synced; resolve it before refreshing history');
          }
        }
        Object.entries(registry.items || {}).forEach(([id, tournament]) => {
          const anonymized = anonymizeLocalTournamentState(tournament, deletedPlayer, anonymizedName);
          if (updatedIds.has(String(id))) {
            anonymized.sync = {
              ...(anonymized.sync || {}),
              status: 'synced',
              lastSynced: new Date().toISOString()
            };
          }
          registry.items[id] = anonymized;
          if (String(state.tournamentId) === String(id)) state = anonymized;
        });
        saveRegistry();
      }

      async function refreshAnonymizedTournaments(tournamentIds) {
        for (const id of tournamentIds || []) {
          if (hasUnsyncedPlayerDeletionChanges()) {
            throw new Error('Local tournament changes are unsynced; resolve them before refreshing history');
          }
          const tournament = await requestAdminApi(`/api/tournaments/${encodeURIComponent(id)}`);
          if (!tournament.exists || !tournament.data) {
            throw new Error(`Updated tournament ${id} could not be reloaded`);
          }
          const previous = registry.items[String(id)] || createDefaultState(id, tournament.data.config?.name || 'Tournament');
          if (registry.items[String(id)] && previous.sync?.status !== 'synced') {
            throw new Error('A local tournament has not been synced; resolve it before refreshing history');
          }
          const refreshed = normalizeTournamentState({
            ...tournament.data,
            tournamentId: String(id),
            auth: state.auth,
            ui: previous.ui || {},
            sync: {
              ...(previous.sync || {}),
              status: 'synced',
              revision: tournament.revision,
              lastSynced: tournament.updatedAt || new Date().toISOString()
            }
          }, String(id));
          registry.items[String(id)] = refreshed;
          if (String(state.tournamentId) === String(id)) state = refreshed;
        }
        saveRegistry();
      }

      async function openBulkPlayerDeletion() {
        if (state.auth.role !== 'admin') return;
        const directory = await requestAdminApi('/api/player-import/directory');
        const profiles = directory.profiles.filter(profile => !isAnonymizedPlayerName(profile.name));
        if (!profiles.length) {
          showToast('No player profiles to delete');
          return;
        }
        openModal(`
          <div class="w-full max-w-lg rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
            <div>
              <h3 class="text-base font-bold">Select players to delete</h3>
              <p class="mt-1 text-xs text-stone-500">Select individual saved profiles or all ${profiles.length} saved profiles. Local-only roster entries are not included.</p>
            </div>
            <label class="flex items-center gap-2 text-xs font-bold">
              <input id="bulk-player-select-all" type="checkbox" class="rounded border-stone-300" /> Select all saved profiles
            </label>
            <div class="max-h-64 overflow-y-auto space-y-1 border border-stone-200 dark:border-stone-800 rounded-lg p-2">
              ${profiles.map((profile, index) => `
                <label class="flex items-center gap-2 p-2 text-xs">
                  <input type="checkbox" data-bulk-player-index="${index}" class="rounded border-stone-300" />
                  <span>${esc(profile.name)}${profile.playerCode ? ` <span class="text-stone-500">(${esc(profile.playerCode)})</span>` : ''}</span>
                </label>
              `).join('')}
            </div>
            <div class="flex justify-end gap-2">
              <button id="bulk-player-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button id="bulk-player-next" type="button" disabled class="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-bold disabled:opacity-50">Delete selected (0)</button>
            </div>
          </div>
        `);
        const selectAll = document.getElementById('bulk-player-select-all');
        const checkboxes = [...document.querySelectorAll('[data-bulk-player-index]')];
        const next = document.getElementById('bulk-player-next');
        const updateSelection = () => {
          const count = checkboxes.filter(checkbox => checkbox.checked).length;
          selectAll.checked = count === checkboxes.length;
          selectAll.indeterminate = count > 0 && count < checkboxes.length;
          next.disabled = count === 0;
          next.textContent = `Delete selected (${count})`;
        };
        selectAll.addEventListener('change', () => {
          checkboxes.forEach(checkbox => { checkbox.checked = selectAll.checked; });
          updateSelection();
        });
        checkboxes.forEach(checkbox => checkbox.addEventListener('change', updateSelection));
        document.getElementById('bulk-player-cancel').addEventListener('click', closeModal);
        next.addEventListener('click', () => {
          const selected = checkboxes.filter(checkbox => checkbox.checked)
            .map(checkbox => profiles[Number(checkbox.dataset.bulkPlayerIndex)]);
          confirmBulkPlayerDeletion(selected);
        });
      }

      function hasUnsyncedPlayerDeletionChanges() {
        return Boolean(syncTimer || syncInFlight || scoreSaveInProgress || checkInSaveInProgress ||
          Object.values(registry.items || {}).some(tournament =>
            ['pending', 'syncing', 'error'].includes(tournament.sync?.status)));
      }

      function confirmBulkPlayerDeletion(profiles) {
        if (state.auth.role !== 'admin' || !profiles.length) return;
        openModal(`
          <div class="w-full max-w-lg rounded-2xl bg-white dark:bg-[#191B1F] border border-red-300 dark:border-red-900/60 p-6 space-y-4">
            <h3 class="text-base font-bold text-red-600 dark:text-red-400">Delete ${profiles.length} player profile${profiles.length === 1 ? '' : 's'}?</h3>
            <p class="text-xs text-stone-500">This permanently deletes the selected profiles, logins, sessions, invitations, and check-ins. Scores remain, but the players' names are anonymized. This cannot be undone.</p>
            <div class="max-h-32 overflow-y-auto text-xs text-stone-500">${profiles.map(profile => `<div>${esc(profile.name)}</div>`).join('')}</div>
            <div class="flex justify-end gap-2">
              <button id="bulk-player-confirm-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button id="bulk-player-confirm" type="button" class="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-bold">Delete profiles</button>
            </div>
          </div>
        `);
        document.getElementById('bulk-player-confirm-cancel').addEventListener('click', closeModal);
        document.getElementById('bulk-player-confirm').addEventListener('click', async event => {
          const button = event.currentTarget;
          button.disabled = true;
          document.getElementById('bulk-player-confirm-cancel').disabled = true;
          if (hasUnsyncedPlayerDeletionChanges()) {
            button.disabled = false;
            document.getElementById('bulk-player-confirm-cancel').disabled = false;
            showToast('Resolve unsynced tournament changes before deleting players', 'error');
            return;
          }
          const updatedIds = new Set();
          let cacheError = false;
          button.textContent = 'Deleting profiles...';
          let deleted;
          try {
            const result = await requestAdminApi('/api/players/delete-batch', {
              method: 'POST',
              body: JSON.stringify({ players: profiles.map(profile => ({
                name: profile.name, playerId: profile.playerId, revision: profile.revision
              })) })
            });
            deleted = result.deleted;
          } catch (err) {
            button.disabled = false;
            button.textContent = 'Delete profiles';
            document.getElementById('bulk-player-confirm-cancel').disabled = false;
            showToast(`Could not confirm player deletion: ${err.message}. Refresh the directory before retrying.`, 'error');
            return;
          }
          for (const result of deleted) {
            (result.updatedTournamentIds || []).forEach(id => updatedIds.add(id));
            try {
              cacheError = !removeCachedPlayerProfile(result.deletedPlayer) || cacheError;
              refreshLocalTournamentStates(result.updatedTournamentIds, result.deletedPlayer, result.anonymizedName);
            } catch (err) {
              console.error('Player was deleted, but local history could not be updated:', err);
              cacheError = true;
            }
          }
          let refreshError = '';
          if (deleted.length) {
            try {
              await refreshAnonymizedTournaments([...updatedIds]);
            } catch (err) {
              refreshError = err.message;
              console.error('Players were deleted, but anonymized tournaments could not be reloaded:', err);
            }
            playerData.loaded = false;
            await loadPlayerData(true);
            state.ui.selectedPlayerName = '';
            state.ui.headToHeadOpponent = '';
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.delete('player');
            history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
            saveRegistry();
            render();
          }
          if (refreshError || cacheError || playerData.error) {
            openModal(`
              <div role="alert" class="w-full max-w-lg rounded-2xl bg-white dark:bg-[#191B1F] border border-red-300 dark:border-red-900/60 p-6 space-y-4">
                <h3 class="text-base font-bold">Deleted ${deleted.length} profiles</h3>
                ${refreshError || cacheError || playerData.error ? `<p class="text-xs text-red-600 dark:text-red-400">Local history refresh needs attention${refreshError ? `: ${esc(refreshError)}` : ''}${playerData.error ? `: ${esc(playerData.error)}` : ''}.</p>` : ''}
                <div class="flex justify-end"><button id="bulk-player-result-close" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Close</button></div>
              </div>
            `);
            document.getElementById('bulk-player-result-close').addEventListener('click', closeModal);
          } else {
            closeModal();
            showToast(`Deleted ${deleted.length} player profile${deleted.length === 1 ? '' : 's'}; scores were anonymized`, 'success');
          }
        });
      }

      function confirmAdminDeletePlayerProfile(profile) {
        const playerName = profile.name;
        openModal(`
          <div class="w-full max-w-lg rounded-2xl bg-white dark:bg-[#191B1F] border border-red-300 dark:border-red-900/60 p-6 space-y-4">
            <div>
              <h3 class="text-base font-bold text-red-600 dark:text-red-400">Delete ${esc(playerName)}'s profile and history?</h3>
              <p class="mt-2 text-xs text-stone-500">This permanently deletes the profile, login, sessions, invitations, and check-ins. Scores stay in tournament records, but this player's name is replaced with an anonymous label so opponents' stats remain intact.</p>
            </div>
            <div class="flex justify-end gap-2">
              <button id="admin-delete-profile-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button id="admin-delete-profile-confirm" type="button" class="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-bold">Delete profile</button>
            </div>
          </div>
        `);
        document.getElementById('admin-delete-profile-cancel').addEventListener('click', closeModal);
        document.getElementById('admin-delete-profile-confirm').addEventListener('click', async event => {
          const button = event.currentTarget;
          if (hasUnsyncedPlayerDeletionChanges()) {
            showToast('Resolve unsynced tournament changes before deleting players', 'error');
            return;
          }
          button.disabled = true;
          button.textContent = 'Deleting…';
          try {
            const result = await requestAdminApi(`/api/players/${encodeURIComponent(playerName)}?playerId=${encodeURIComponent(profile.playerId)}`, {
              method: 'DELETE',
              headers: { 'x-player-revision': profile.revision }
            });
            closeModal();
            const cacheRemoved = removeCachedPlayerProfile(result.deletedPlayer);
            refreshLocalTournamentStates(result.updatedTournamentIds, result.deletedPlayer, result.anonymizedName);
            let refreshError = '';
            try {
              await refreshAnonymizedTournaments(result.updatedTournamentIds);
            } catch (err) {
              refreshError = err.message;
              console.error('Player was deleted, but anonymized tournaments could not be reloaded:', err);
            }
            playerData.loaded = false;
            await loadPlayerData(true);
            state.ui.selectedPlayerName = '';
            state.ui.headToHeadOpponent = '';
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.delete('player');
            history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
            saveRegistry();
            render();
            if (refreshError || !cacheRemoved || playerData.error) {
              showToast(`Player deleted; local history refresh needs attention${refreshError ? `: ${refreshError}` : ''}`, 'error');
            } else {
              showToast(result.message || 'Player profile deleted and history anonymized', 'success');
            }
          } catch (err) {
            button.disabled = false;
            button.textContent = 'Delete profile';
            showToast(`Could not delete player profile: ${err.message}`, 'error');
          }
        });
      }

      function confirmPlayerAccountDeletion() {
        openModal(`
          <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-red-300 dark:border-red-900/60 p-6 space-y-4">
            <div>
              <h3 class="text-base font-bold text-red-600 dark:text-red-400">Delete your login account?</h3>
              <p class="mt-2 text-xs text-stone-500">This removes your ability to sign in. Your player profile, email, tournament rosters, scores, and history will remain.</p>
            </div>
            <div class="flex justify-end gap-2">
              <button id="player-delete-account-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button id="player-delete-account-confirm" type="button" class="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-bold">Delete my login</button>
            </div>
          </div>
        `);
        document.getElementById('player-delete-account-cancel').addEventListener('click', closeModal);
        document.getElementById('player-delete-account-confirm').addEventListener('click', async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await requestPlayerApi('/api/player-auth/me', { method: 'DELETE' });
            closeModal();
            clearPlayerAccountProfile();
            state.auth.loggedIn = false;
            state.auth.role = 'guest';
            saveRegistry();
            render();
            showToast('Your login was deleted; your player history was kept', 'success');
          } catch (err) {
            button.disabled = false;
            showToast(`Could not delete your login: ${err.message}`, 'error');
          }
        });
      }

      function resetPlayerPassword(playerName) {
        openModal(`
          <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
            <div>
              <h3 class="text-base font-bold">Reset ${esc(playerName)}'s password?</h3>
              <p class="mt-2 text-xs text-stone-500">Existing player sessions will end. A one-time temporary password will be shown once and must be changed after sign-in.</p>
            </div>
            <div class="flex justify-end gap-2">
              <button id="admin-reset-password-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button id="admin-reset-password-confirm" type="button" class="px-4 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Reset password</button>
            </div>
          </div>
        `);
        document.getElementById('admin-reset-password-cancel').addEventListener('click', closeModal);
        document.getElementById('admin-reset-password-confirm').addEventListener('click', async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const result = await requestAdminApi(
              `/api/player-accounts/${encodeURIComponent(playerName)}/reset-password`,
              { method: 'POST' }
            );
            openModal(`
              <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-emerald-500/30 p-6 space-y-4">
                <div>
                  <h3 class="text-base font-bold">Temporary password for ${esc(result.playerName)}</h3>
                  <p class="mt-1 text-xs text-stone-500">Share this privately. It is shown only once and the player must change it when they sign in.</p>
                </div>
                <input id="admin-temporary-password" type="text" readonly value="${esc(result.temporaryPassword)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 font-mono text-sm" />
                <div class="flex justify-end gap-2">
                  <button id="admin-copy-temporary-password" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold">Copy password</button>
                  <button id="admin-temporary-password-done" type="button" class="px-4 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Done</button>
                </div>
              </div>
            `);
            document.getElementById('admin-copy-temporary-password').addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(result.temporaryPassword);
                showToast('Temporary password copied', 'success');
              } catch (_err) {
                document.getElementById('admin-temporary-password').select();
                showToast('Clipboard unavailable; select and copy the password', 'error');
              }
            });
            document.getElementById('admin-temporary-password-done').addEventListener('click', closeModal);
          } catch (err) {
            closeModal();
            showToast(`Could not reset player password: ${err.message}`, 'error');
          }
        });
      }

      function confirmAdminDeletePlayerLogin(playerName) {
        openModal(`
          <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-red-300 dark:border-red-900/60 p-6 space-y-4">
            <div>
              <h3 class="text-base font-bold text-red-600 dark:text-red-400">Delete ${esc(playerName)}'s login?</h3>
              <p class="mt-2 text-xs text-stone-500">This removes the player's login and ends active sessions. Their player profile, rosters, scores, and tournament history will remain.</p>
            </div>
            <div class="flex justify-end gap-2">
              <button id="admin-delete-account-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button id="admin-delete-account-confirm" type="button" class="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-bold">Delete login</button>
            </div>
          </div>
        `);
        document.getElementById('admin-delete-account-cancel').addEventListener('click', closeModal);
        document.getElementById('admin-delete-account-confirm').addEventListener('click', async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const result = await requestAdminApi(`/api/player-accounts/${encodeURIComponent(playerName)}`, {
              method: 'DELETE'
            });
            closeModal();
            showToast(result.message || `Deleted ${playerName}'s login`, 'success');
          } catch (err) {
            button.disabled = false;
            showToast(`Could not delete player login: ${err.message}`, 'error');
          }
        });
      }

      function renderThemeSwitcher() {
        const btn = (mode, label) => {
          const active = themeMode === mode;
          return `<button data-theme-btn="${mode}" class="px-2.5 py-1 text-xs font-medium rounded-md transition ${active ? 'bg-gold-500 text-stone-950 shadow-sm' : 'text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-700/60'}">${label}</button>`;
        };
        return `
          <div class="inline-flex items-center p-0.5 rounded-lg bg-cream-200/80 dark:bg-stone-800 border border-stone-300/70 dark:border-stone-700">
            ${btn('light', 'Light')}
            ${btn('dark', 'Dark')}
            ${btn('system', 'System')}
          </div>
        `;
      }

      function renderLoginScreen() {
        const adminSession = usesAdminSession();
        const inviteForm = playerInviteContext ? `
          <form id="player-register-form" class="mt-4 border-t border-stone-200 dark:border-stone-800 pt-4 space-y-3">
            <h2 class="text-sm font-bold">Create Player Account</h2>
            ${playerInviteContext.invite.targetName ? `
              <div>
                <label for="register-player-name" class="block text-xs font-semibold text-stone-500 mb-1">Full name</label>
                <input id="register-player-name" type="text" readonly value="${esc(playerInviteContext.invite.targetName)}" class="w-full px-3 py-2 rounded-lg bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-700 text-sm" />
              </div>
            ` : `
              <div>
                <label for="register-player-type" class="block text-xs font-semibold text-stone-500 mb-1">Player identity</label>
                <select id="register-player-type" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm">
                  <option value="existing" ${playerInviteContext.roster.length ? '' : 'disabled'}>I am an existing roster player</option>
                  <option value="new" ${playerInviteContext.roster.length ? '' : 'selected'}>Create a new player profile</option>
                </select>
              </div>
              <div id="register-existing-player-wrap">
                <label for="register-existing-player" class="block text-xs font-semibold text-stone-500 mb-1">Roster player</label>
                <select id="register-existing-player" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm">
                  ${playerInviteContext.roster.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}
                </select>
              </div>
              <div id="register-new-player-wrap" class="hidden">
                <label for="register-new-player" class="block text-xs font-semibold text-stone-500 mb-1">Full name</label>
                <input id="register-new-player" type="text" maxlength="120" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
              </div>
              ${playerInviteContext.roster.length === 0 ? '<p class="text-[11px] text-stone-500">No unclaimed roster players are available; choose a new profile.</p>' : ''}
            `}
            <div>
              <label for="register-player-email" class="block text-xs font-semibold text-stone-500 mb-1">Email address</label>
              <input id="register-player-email" type="email" maxlength="254" required value="${esc(playerInviteContext.invite.targetEmail)}" ${playerInviteContext.invite.targetEmail ? 'readonly' : ''} class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
            </div>
            <div>
              <label for="register-player-password" class="block text-xs font-semibold text-stone-500 mb-1">Password (12+ characters)</label>
              <input id="register-player-password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
            </div>
            <div>
              <label for="register-player-password-confirm" class="block text-xs font-semibold text-stone-500 mb-1">Confirm password</label>
              <input id="register-player-password-confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" required class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
            </div>
            <p id="player-register-error" role="alert" class="${playerInviteError ? '' : 'hidden'} text-xs text-red-600 dark:text-red-400">${esc(playerInviteError)}</p>
            <button type="submit" class="w-full py-2.5 px-4 rounded-xl bg-gold-500 hover:bg-gold-400 text-stone-950 font-semibold text-sm">Create Player Account</button>
          </form>
        ` : '';
        return `
          <div class="min-h-screen flex flex-col items-center justify-center p-4">
            <div class="absolute top-4 right-4">${renderThemeSwitcher()}</div>
            <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 shadow-xl p-6 sm:p-8">
              <div class="flex items-center gap-3 mb-6">
                <div class="w-11 h-11 rounded-xl bg-gold-500/15 border border-gold-500/30 flex items-center justify-center text-gold-600 dark:text-gold-400">
                  <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L20 20"/><path d="M7 7l6 6M13 7l-6 6"/>
                  </svg>
                </div>
                <div>
                  <h1 class="text-lg font-bold tracking-tight">${esc(state.config.name)}</h1>
                  <p class="text-xs text-stone-500 dark:text-stone-400">Tournament Manager Login</p>
                </div>
              </div>

              <form id="login-form" class="space-y-4">
                <div>
                  <label for="pin-input" class="block text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-1.5">${adminSession ? 'Admin password' : '4-Digit Admin PIN'}</label>
                  <input id="pin-input" type="password" ${adminSession ? 'maxlength="256" autocomplete="current-password"' : 'inputmode="numeric" maxlength="4" placeholder="••••"'} required
                    class="w-full px-4 py-2.5 rounded-xl bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-center text-lg tracking-[0.4em] font-semibold focus:outline-none focus:ring-2 focus:ring-gold-500" />
                </div>
                ${adminAuthError ? `<p role="alert" class="text-xs text-red-600 dark:text-red-400">${esc(adminAuthError)}</p>` : ''}
                <button type="submit" class="w-full py-2.5 px-4 rounded-xl bg-gold-500 hover:bg-gold-400 text-stone-950 font-semibold text-sm transition shadow-sm">
                  Enter as Admin
                </button>
              </form>

              <div class="relative my-5 flex items-center">
                <div class="flex-grow border-t border-stone-200 dark:border-stone-800"></div>
                <span class="px-3 text-xs text-stone-400">or</span>
                <div class="flex-grow border-t border-stone-200 dark:border-stone-800"></div>
              </div>

              <div class="space-y-2.5">
                <details ${playerInviteContext ? 'open' : ''} class="rounded-xl border border-stone-200 dark:border-stone-800 p-3">
                  <summary class="cursor-pointer text-sm font-semibold">Player Login</summary>
                  <form id="player-login-form" class="pt-3 space-y-3">
                    <div>
                      <label for="player-login-email" class="block text-xs font-semibold text-stone-500 mb-1">Email</label>
                      <input id="player-login-email" type="email" required autocomplete="username" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
                    </div>
                    <div>
                      <label for="player-login-password" class="block text-xs font-semibold text-stone-500 mb-1">Password</label>
                      <input id="player-login-password" type="password" required autocomplete="current-password" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
                    </div>
                    <p id="player-login-error" role="alert" class="${playerAuthError ? '' : 'hidden'} text-xs text-red-600 dark:text-red-400">${esc(playerAuthError)}</p>
                    <button type="submit" class="w-full py-2.5 px-4 rounded-xl bg-gold-500 hover:bg-gold-400 text-stone-950 font-semibold text-sm">Sign In as Player</button>
                  </form>
                  ${inviteForm}
                  ${!playerInviteContext ? '<p class="text-[11px] text-stone-500 mt-2">Player registration requires an invitation link from an administrator.</p>' : ''}
                  ${!playerInviteContext && playerInviteError ? `<p role="alert" class="text-xs text-red-600 dark:text-red-400">${esc(playerInviteError)}</p>` : ''}
                </details>
                <button id="guest-btn" class="w-full py-2.5 px-4 rounded-xl border border-stone-300 dark:border-stone-700 hover:bg-cream-100 dark:hover:bg-stone-800 font-medium text-sm transition">
                  Continue as Guest (View Only)
                </button>
              </div>
            </div>
          </div>
        `;
      }

      function renderHeader() {
        const isAdmin = state.auth.role === 'admin';
        const roleLabel = isAdmin ? 'Admin' : state.auth.role === 'player' ? 'Player' : 'Guest';
        const phaseLabels = { setup: 'Setup', qr1: 'Qualifier R1', qr2: 'Qualifier R2', semis: 'Semi-Finals', finals: 'Finals', completed: 'Completed' };
        return `
          <header class="border-b border-stone-200 dark:border-stone-800 bg-white/90 dark:bg-[#17191D]/90 backdrop-blur sticky top-0 z-30">
            <div class="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-3 flex-wrap">
                <div class="w-9 h-9 rounded-lg bg-gold-500/15 border border-gold-500/30 flex items-center justify-center text-gold-600 dark:text-gold-400 shrink-0">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <circle cx="10" cy="10" r="6"/><path d="M14.5 14.5L20 20"/>
                  </svg>
                </div>
                <select id="tournament-switcher" aria-label="Switch current tournament" class="font-bold text-sm sm:text-base tracking-tight bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 rounded-lg px-2.5 py-1 max-w-[240px] sm:max-w-xs truncate">
                  ${Object.values(registry.items).filter(t =>
                    !getSyncApiUrl() || !remoteTournamentIds || remoteTournamentIds.has(String(t.tournamentId)) ||
                    String(t.tournamentId) === String(state.tournamentId) ||
                    (t.sync?.status !== 'synced' && t.sync?.revision !== null)
                  ).map(t => `<option value="${esc(t.tournamentId)}" ${t.tournamentId === state.tournamentId ? 'selected' : ''}>${esc(t.config?.name || 'Tournament')}</option>`).join('')}
                </select>
                ${state.phase !== 'setup' && phaseLabels[state.phase] ? `<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-gold-500/15 text-gold-600 dark:text-gold-400 border border-gold-500/30">${state.phase === 'completed' && state.closedEarly ? 'Closed' : phaseLabels[state.phase]}</span>` : ''}
                <span class="px-2 py-0.5 text-xs font-medium rounded-full ${isAdmin ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30' : state.auth.role === 'player' ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-500/30' : 'bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-300'}">${roleLabel}</span>
                ${isAdmin ? `<button id="open-sync-modal-btn" class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs border ${state.sync?.status === 'synced' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : state.sync?.status === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-500' : 'border-stone-300 dark:border-stone-700 text-stone-500 dark:text-stone-400'}"><span class="w-1.5 h-1.5 rounded-full ${state.sync?.status === 'synced' ? 'bg-emerald-500' : state.sync?.status === 'error' ? 'bg-red-500' : 'bg-stone-400'}"></span><span id="sync-status-pill">${state.sync?.status === 'synced' ? 'Cloud Synced' : state.sync?.status === 'error' ? 'Sync Error' : 'Cloud Sync'}</span></button>` : ''}
                <button id="logout-btn" class="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 underline underline-offset-2">Logout</button>
              </div>

              <div class="flex items-center gap-2 flex-wrap">
                ${isAdmin ? `
                  <button id="share-btn" class="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-stone-300 dark:border-stone-700 hover:bg-cream-100 dark:hover:bg-stone-800 transition">Share</button>
                  <button id="export-btn" class="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-stone-300 dark:border-stone-700 hover:bg-cream-100 dark:hover:bg-stone-800 transition">Export</button>
                  <button id="reset-btn" class="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-red-300 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition">Reset</button>
                ` : ''}
                ${renderThemeSwitcher()}
              </div>
            </div>
          </header>
        `;
      }

      function renderNavTabs() {
        const isAdmin = state.auth.role === 'admin';
        const isPlayer = state.auth.role === 'player';
        const stats = getStatsSummary();
        const checkIns = getAllImportedPlayers();
        const navButton = (id, label, badge) => `
          <a href="${esc(getPageUrl(id))}" data-tab="${id}" aria-current="${state.ui.activeTab === id ? 'page' : 'false'}" class="w-full min-h-11 text-left flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-xs font-medium transition ${state.ui.activeTab === id ? 'bg-gold-500/15 text-gold-700 dark:text-gold-300' : 'text-stone-600 dark:text-stone-300 hover:bg-cream-100 dark:hover:bg-stone-800'}">
            <span>${label}</span>
            ${badge ? `<span class="text-[10px] text-stone-500 tabular-nums">${badge}</span>` : ''}
          </a>
        `;
        const categoryLabel = 'block px-2 pb-1 text-[9px] font-bold uppercase tracking-[0.14em] text-stone-400 dark:text-stone-500';
        const summaryClass = active => `inline-flex items-center gap-1.5 px-3 py-2 rounded-lg cursor-pointer list-none text-xs font-semibold transition ${active ? 'bg-gold-500/15 text-gold-700 dark:text-gold-300' : 'text-stone-600 dark:text-stone-300 hover:bg-cream-100 dark:hover:bg-stone-800'}`;
        const matchActive = ['qr1', 'qr2', 'semis', 'finals', 'bracket'].includes(state.ui.activeTab);
        const peopleActive = ['players', 'checkin'].includes(state.ui.activeTab);
        return `
          <nav aria-label="Tournament navigation" class="relative z-20 border-b border-stone-200 dark:border-stone-800 bg-white dark:bg-[#15171B]">
            <div class="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <div class="min-w-[7rem]">
                <span class="${categoryLabel}">Overview</span>
                ${navButton('dashboard', 'Dashboard')}
              </div>
              <div class="min-w-[9rem]">
                <span class="${categoryLabel}">Tournament</span>
                <div class="grid grid-cols-2 gap-1">
                  ${navButton('tournaments', 'Tournaments')}
                  ${isAdmin ? navButton('setup', 'Setup') : ''}
                </div>
              </div>
              <details class="relative min-w-[8rem]">
                <summary class="${summaryClass(matchActive)}">
                  <span class="${categoryLabel.replace('block ', 'inline-block ')} !px-0 !pb-0">Match Center</span>
                  <span aria-hidden="true" class="text-[10px]">▾</span>
                </summary>
                <div class="absolute left-0 top-full mt-1 w-56 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-[#191B1F] p-2 shadow-xl">
                  <span class="${categoryLabel}">Rounds</span>
                  ${navButton('qr1', 'Qualifier Round 1', `${stats.qr1Done}/${stats.qr1Total || 0}`)}
                  ${navButton('qr2', 'Qualifier Round 2', `${stats.qr2Done}/${stats.qr2Total || 0}`)}
                  ${navButton('semis', 'Semi-Finals', `${stats.semiDone}/${stats.semiTotal || 0}`)}
                  ${navButton('finals', 'Finals', `${stats.finalDone}/${stats.finalTotal || 0}`)}
                  <div class="mt-1 border-t border-stone-200 dark:border-stone-700 pt-1">
                    <a id="open-bracket-btn" href="${esc(getPageUrl('bracket'))}" data-tab="bracket" aria-current="${state.ui.activeTab === 'bracket' ? 'page' : 'false'}" class="block w-full min-h-11 text-left px-3 py-3 rounded-lg text-xs font-semibold text-gold-700 dark:text-gold-300 hover:bg-cream-100 dark:hover:bg-stone-800">View tournament bracket</a>
                  </div>
                </div>
              </details>
              <details class="relative min-w-[8rem]">
                <summary class="${summaryClass(peopleActive)}">
                  <span class="${categoryLabel.replace('block ', 'inline-block ')} !px-0 !pb-0">Players &amp; Check-In</span>
                  <span aria-hidden="true" class="text-[10px]">▾</span>
                </summary>
                <div class="absolute left-0 top-full mt-1 w-52 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-[#191B1F] p-2 shadow-xl">
                  <span class="${categoryLabel}">Participants</span>
                  ${navButton('players', isPlayer ? 'My Player Card' : 'Players & Performance')}
                  ${navButton('checkin', 'Attendance', `${checkIns.filter(player => state.checkIns?.[player.name]?.checkedIn).length}/${checkIns.length}`)}
                </div>
              </details>
              <div class="min-w-[5rem]">
                <span class="${categoryLabel}">Information</span>
                ${navButton('rules', 'Rules & Format')}
              </div>
            </div>
          </nav>
        `;
      }

      function renderActiveView() {
        switch (state.ui.activeTab) {
          case 'setup': return renderSetupView();
          case 'qr1': return renderQR1View();
          case 'qr2': return renderQR2View();
          case 'semis': return renderSemisView();
          case 'finals': return renderFinalsView();
          case 'bracket': return renderBracketOverlay(true);
          case 'dashboard': return renderDashboardView();
          case 'tournaments':
            if (!tournamentCatalog.loaded && !tournamentCatalog.loading) {
              loadTournamentCatalog().then(() => {
                if (state.ui.activeTab === 'tournaments') render();
              });
            }
            return renderTournamentCatalogView();
          case 'rules': return renderRulesView();
          case 'players':
            if (!playerData.loaded && !playerData.loading) {
              loadPlayerData().then(() => {
                if (state.ui.activeTab === 'players') render();
              });
            }
            return renderPlayerProfilesView();
          case 'checkin': return renderCheckInView();
          default: return renderDashboardView();
        }
      }

      function renderSetupView() {
        const c = state.config;
        const setupSteps = [
          { title: 'Event details', description: 'Name your event and share any organizer-specific rules.' },
          { title: 'Format & scoring', description: 'Choose group sizes, match counts, scoring, and tournament progression.' },
          { title: 'Players & groups', description: 'Review the roster, assign group leaders, and organize players.' },
          { title: 'Ranking rules', description: 'Set how standings and tiebreakers are calculated.' },
          { title: 'Review & start', description: 'Confirm the tournament setup before generating the schedule.' }
        ];
        const setupStep = Math.max(1, Math.min(setupSteps.length, Number(state.ui.setupStep) || 1));
        const totalPlayers = state.groups.reduce((s, g) => s + g.players.length, 0);
        const round2GroupKeys = getConfiguredPoolKeys();
        const round2GroupBaseSize = Math.floor(totalPlayers / round2GroupKeys.length);
        const round2GroupRemainder = totalPlayers % round2GroupKeys.length;
        const maxRound2GroupCount = Math.min(6, Math.floor(totalPlayers / 8));
        const invalidGroup = state.groups.find(g => g.players.length < 4 || !g.leader || !g.players.includes(g.leader));
        const round1Error = getRound1SetupError();
        const round2Error = getRound2SetupError();
        const scheduleError = round1Error || round2Error;
        const setupReady = state.groups.length >= 2 && !invalidGroup && !scheduleError;

        return `
          <div class="space-y-6">
            <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-4">
              <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
                <div>
                  <p class="text-[10px] font-bold uppercase tracking-[0.16em] text-gold-600 dark:text-gold-400">Tournament setup</p>
                  <h1 class="mt-1 text-xl sm:text-2xl font-bold">Set up your tournament</h1>
                  <p class="mt-1 text-xs sm:text-sm text-stone-500 dark:text-stone-400">${esc(setupSteps[setupStep - 1].description)}</p>
                </div>
                <span class="shrink-0 text-xs font-semibold text-stone-500 dark:text-stone-400">Step ${setupStep} of ${setupSteps.length}</span>
              </div>
              <div class="h-1.5 rounded-full bg-stone-100 dark:bg-stone-800 overflow-hidden" role="progressbar" aria-label="Tournament setup progress" aria-valuemin="1" aria-valuemax="${setupSteps.length}" aria-valuenow="${setupStep}">
                <div class="h-full rounded-full bg-gold-500 transition-all" style="width:${setupStep / setupSteps.length * 100}%"></div>
              </div>
              <nav aria-label="Tournament setup steps" class="flex gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-5 sm:overflow-visible">
                ${setupSteps.map((step, index) => {
                  const stepNumber = index + 1;
                  const active = stepNumber === setupStep;
                  const complete = stepNumber < setupStep;
                  return `
                    <button type="button" data-setup-step-nav="${stepNumber}" aria-label="Go to step ${stepNumber}: ${esc(step.title)}" aria-current="${active ? 'step' : 'false'}"
                      class="min-h-11 min-w-32 sm:min-w-0 shrink-0 rounded-lg border px-3 py-2 text-left text-xs font-semibold transition ${active ? 'border-gold-500 bg-gold-500/10 text-gold-700 dark:text-gold-300' : 'border-stone-200 dark:border-stone-700 text-stone-500 hover:bg-cream-100 dark:hover:bg-stone-800'}">
                      <span class="flex items-center gap-2"><span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${active ? 'bg-gold-500 text-stone-950' : complete ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-stone-100 dark:bg-stone-800'}">${complete ? '✓' : stepNumber}</span>${esc(step.title)}</span>
                    </button>
                  `;
                }).join('')}
              </nav>
            </section>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <!-- Event -->
              <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-5 space-y-4 lg:col-span-2 ${setupStep === 1 ? '' : 'hidden'}">
                <h2 class="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">Event</h2>
                <div class="space-y-3">
                  <div>
                    <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Tournament Name</label>
                    <input data-cfg="name" type="text" value="${esc(c.name)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Date</label>
                      <input data-cfg="date" type="date" value="${esc(c.date)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
                    </div>
                    <div>
                      <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Venue</label>
                      <input data-cfg="venue" type="text" value="${esc(c.venue)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
                    </div>
                  </div>
                </div>
              </section>

              <!-- Format & Scoring -->
              <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-5 space-y-4 lg:col-span-2 ${setupStep === 2 ? '' : 'hidden'}">
                <h2 class="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">Format &amp; Scoring</h2>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Groups</label>
                    <input id="cfg-num-groups" type="number" min="2" max="8" value="${c.numGroups}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                  </div>
                  <div>
                    <label for="cfg-total-players" class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Rostered Players Target</label>
                    <input id="cfg-total-players" type="number" min="0" step="1" value="${c.rosterTarget ?? totalPlayers}" ${state.auth.role === 'admin' ? '' : 'readonly'} aria-describedby="cfg-total-players-help" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                    <p id="cfg-total-players-help" class="mt-1 text-xs text-stone-500">${totalPlayers} actually rostered. Target is for planning only; edit groups to change the roster.</p>
                  </div>
                  <div>
                    <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Players / Group Target</label>
                    <input id="cfg-players-per-group" type="number" min="4" max="12" value="${c.playersPerGroup}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                  </div>
                  <div>
                    <label for="cfg-qr1-matches" class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Round 1 Matches / Player</label>
                    <input id="cfg-qr1-matches" type="number" min="1" max="9" step="1" value="${esc(c.matchesPerPlayer)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Points to Win</label>
                    <input data-cfg-num="pointsToWin" type="number" min="11" max="30" value="${c.pointsToWin}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Deuce Cap</label>
                    <input data-cfg-num="deuceCap" type="number" min="15" max="35" value="${c.deuceCap}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                  </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-1">
                  <div>
                    <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Round 2 Groups</label>
                    <input data-cfg-num="qr2PoolsCount" type="number" min="2" max="${Math.max(2, maxRound2GroupCount)}" value="${c.qr2PoolsCount || 2}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                  </div>
                  <div>
                    <label for="cfg-qr2-matches" class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Round 2 Matches / Player</label>
                    <input id="cfg-qr2-matches" type="number" min="1" max="79" step="1" value="${esc(c.qr2MatchesPerPlayer ?? c.matchesPerPlayer)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                  </div>
                  ${round2GroupKeys.map(key => `
                    <div>
                      <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Group ${key} Final</label>
                      <select data-pool-final-format="${key}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm">
                        <option value="bo3" ${getPoolFinalFormat(key) === 'bo3' ? 'selected' : ''}>3 sets (Best of 3)</option>
                        <option value="single" ${getPoolFinalFormat(key) === 'single' ? 'selected' : ''}>1 set (Single Game)</option>
                      </select>
                    </div>
                  `).join('')}
                </div>
                <p class="text-xs text-stone-500">Qualifying matches are doubles: four different players per match, and no partnership repeats within a group stage. Each player plays exactly the selected number of matches, which must be less than the group size. Group size multiplied by matches per player must be divisible by 4. Changes apply when schedules are generated or regenerated.${c.qr2MatchesPerPlayer === undefined ? ' This older tournament uses the Round 1 count for Round 2 until this setting is changed.' : ''}</p>
                ${round1Error ? `<p role="alert" class="text-xs text-red-600 dark:text-red-400">${esc(round1Error)}</p>` : ''}
                ${round2Error ? `<p role="alert" class="text-xs text-red-600 dark:text-red-400">${esc(round2Error)}</p>` : ''}
                <p class="text-xs ${totalPlayers < round2GroupKeys.length * 8 ? 'text-amber-600 dark:text-amber-400' : 'text-stone-500'}">${totalPlayers < round2GroupKeys.length * 8 ? 'Each Round 2 group needs at least 8 players so its top 8 can advance to semi-finals.' : "All Round 1 players are ranked by Win Points and tie-breakers, then assigned in consecutive rank blocks; the top 8 from each Round 2 group advance to that group's semi-finals."}</p>
              </section>
            </div>

            <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-5 space-y-3 ${setupStep === 1 ? '' : 'hidden'}">
              <div>
                <h2 class="text-sm font-bold">Event-specific rules</h2>
                <p class="mt-1 text-xs text-stone-500">Add organizer notes, check-in guidance, or event-specific policies. Players can read these from Rules &amp; Format.</p>
              </div>
              <textarea data-cfg="rules" maxlength="8000" rows="4" placeholder="Add event rules and player guidance…" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm resize-y">${esc(c.rules || '')}</textarea>
            </section>

            <!-- Editable Ranking Rules -->
            <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-5 space-y-4 ${setupStep === 4 ? '' : 'hidden'}">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h2 class="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">Ranking Rules</h2>
                <span class="text-xs font-mono text-gold-600 dark:text-gold-400">${esc(getRankingFormulaText())}</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Win Points (per Win)</label>
                  <input data-rk-num="winPointsWeight" type="number" min="0" max="100" value="${c.ranking?.winPointsWeight ?? 20}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                </div>
                <div>
                  <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Win Margin Multiplier</label>
                  <input data-rk-num="winMarginWeight" type="number" min="0" max="10" step="0.5" value="${c.ranking?.winMarginWeight ?? 1}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                </div>
                <div>
                  <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">Loss Margin Penalty</label>
                  <input data-rk-num="lossMarginWeight" type="number" min="0" max="10" step="0.5" value="${c.ranking?.lossMarginWeight ?? 1}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm tabular-nums" />
                </div>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                ${[0, 1, 2, 3].map(idx => {
                  const cur = (c.ranking?.tiebreakers || ['wp', 'wins', 'pf', 'pa'])[idx];
                  return `
                    <div>
                      <label class="block text-xs font-medium text-stone-500 dark:text-stone-400 mb-1">${idx === 0 ? 'Primary Rank' : `Tiebreaker ${idx}`}</label>
                      <select data-rk-tb="${idx}" class="w-full px-2.5 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs">
                        ${Object.entries(TIEBREAKER_LABELS).map(([k, lbl]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${lbl}</option>`).join('')}
                      </select>
                    </div>
                  `;
                }).join('')}
              </div>
            </section>

            <!-- Players & Group Configuration -->
            <section class="space-y-4 ${setupStep === 3 ? '' : 'hidden'}">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 class="text-base font-bold">Players &amp; Group Configuration</h2>
                  <p class="text-xs text-stone-500 dark:text-stone-400">${totalPlayers} registered across ${state.groups.length} groups · Add players from profiles or import a roster. Drag a player by the handle to move them, or use the group menu on touch screens. Click ★ to set a leader.</p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  ${state.auth.role === 'admin' ? '<button id="import-roster-btn" class="min-h-11 rounded-lg border border-stone-300 dark:border-stone-700 px-3 py-2 text-xs font-semibold transition hover:bg-cream-100 dark:hover:bg-stone-800">Import players</button>' : ''}
                  <button id="sort-groups-btn" class="min-h-11 rounded-lg border border-stone-300 dark:border-stone-700 px-3 py-2 text-xs font-semibold transition hover:bg-cream-100 dark:hover:bg-stone-800">Sort A–Z</button>
                  <button id="add-group-btn" class="min-h-11 rounded-lg border border-gold-500/30 bg-gold-500/15 px-3 py-2 text-xs font-semibold text-gold-600 transition hover:bg-gold-500/25 dark:text-gold-400">+ Add Group</button>
                </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                ${state.groups.map((g, gi) => `
                  <div data-player-drop-group="${gi}" aria-label="Drop players into ${esc(g.name)}" class="player-drop-group rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 flex flex-col gap-3 transition-colors">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-2 flex-1 min-w-0">
                        <input data-group-name="${gi}" type="text" value="${esc(g.name)}" class="w-28 sm:w-32 px-2 py-1 rounded-md bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 font-bold text-sm" />
                        <span class="text-xs px-2 py-0.5 rounded-full bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400 tabular-nums">${g.players.length}/${c.playersPerGroup}</span>
                        <span class="text-[11px] px-2 py-0.5 rounded-full bg-gold-500/10 text-gold-600 dark:text-gold-400 tabular-nums" title="Average skill level (1-10)">Avg ${g.players.length ? (g.players.reduce((sum, p) => sum + getPlayerSkill(p), 0) / g.players.length).toFixed(1) : '0.0'}</span>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <span class="text-xs text-gold-600 dark:text-gold-400 font-medium truncate max-w-[90px]">★ ${esc(g.leader || 'None')}</span>
                        ${state.groups.length > 2 ? `<button data-remove-group="${gi}" title="Remove group" class="w-6 h-6 rounded text-stone-400 hover:text-red-500 hover:bg-red-500/10 text-xs">✕</button>` : ''}
                      </div>
                    </div>

                    <div class="space-y-1.5">
                      ${g.players.map((p, pi) => {
                        const isLeader = g.leader === p;
                        return `
                          <div data-player-row="${gi}:${pi}" class="player-roster-row flex items-center gap-1.5 rounded-lg border border-transparent p-1 transition-opacity">
                            ${state.auth.role === 'admin' ? `<button data-player-drag="${gi}:${pi}" type="button" draggable="true" aria-label="Drag ${esc(p)} to another group" title="Drag to another group" class="player-drag-handle w-7 h-8 shrink-0 rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200" aria-grabbed="false">
                              <svg class="mx-auto h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="3" r="1"/><circle cx="11" cy="3" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="11" cy="8" r="1"/><circle cx="5" cy="13" r="1"/><circle cx="11" cy="13" r="1"/></svg>
                            </button>` : ''}
                            <button data-set-leader="${gi}:${pi}" title="Set as group leader" class="w-7 h-7 rounded-lg flex items-center justify-center text-sm transition ${isLeader ? 'bg-gold-500/20 text-gold-500' : 'text-stone-400 hover:text-gold-500 hover:bg-stone-100 dark:hover:bg-stone-800'}">★</button>
                            <input data-player-edit="${gi}:${pi}" type="text" value="${esc(p)}" class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 text-xs sm:text-sm" />
                            <input data-player-skill="${gi}:${pi}" type="number" min="1" max="10" value="${getPlayerSkill(p)}" title="Skill level (1-10)" class="w-12 px-1.5 py-1.5 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 text-xs text-center font-semibold tabular-nums" />
                            <select data-move-player="${gi}:${pi}" title="Move to another group" class="px-1.5 py-1.5 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 text-[11px] text-stone-500">
                              ${state.groups.map((og, ogi) => `<option value="${ogi}" ${ogi === gi ? 'selected' : ''}>${esc(og.id)}</option>`).join('')}
                            </select>
                            <button data-remove-player="${gi}:${pi}" title="Remove player" class="w-7 h-7 rounded-lg text-stone-400 hover:text-red-500 hover:bg-red-500/10 flex items-center justify-center text-xs">✕</button>
                          </div>
                        `;
                      }).join('')}
                    </div>

                    <div class="flex items-center gap-1.5 pt-1">
                      <button data-add-player-btn="${gi}" class="flex-1 px-3 py-1.5 rounded-lg bg-stone-200 dark:bg-stone-800 hover:bg-stone-300 dark:hover:bg-stone-700 text-xs font-medium">+ Add player from profiles</button>
                    </div>
                  </div>
                `).join('')}
              </div>

              <div class="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <p class="text-xs text-stone-500 dark:text-stone-400">Each group needs at least 4 players and a ★ leader.</p>
              </div>
            </section>

            <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-4 ${setupStep === 5 ? '' : 'hidden'}">
              <div>
                <h2 class="text-base font-bold">Review your tournament</h2>
                <p class="mt-1 text-xs text-stone-500 dark:text-stone-400">Check the event, scoring, roster, and standings rules before you create the schedule.</p>
              </div>
              <div class="rounded-xl bg-gold-500/10 border border-gold-500/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm">
                <div class="flex flex-wrap items-center gap-4">
                  <span><strong class="text-gold-600 dark:text-gold-400">Players:</strong> <span class="tabular-nums font-semibold">${totalPlayers}</span></span>
                  ${round2GroupKeys.map((key, index) => {
                    const count = round2GroupBaseSize + (index < round2GroupRemainder ? 1 : 0);
                    return `<span><strong class="${getPoolAccent(key)}">Round 2 Group ${key}:</strong> <span class="tabular-nums font-semibold">${count}</span></span>`;
                  }).join('')}
                </div>
                <span class="text-stone-600 dark:text-stone-300"><strong>Ranking:</strong> ${esc(getTiebreakerText())}</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <article class="rounded-lg border border-stone-200 dark:border-stone-700 p-3 space-y-2">
                  <h3 class="text-xs font-bold uppercase tracking-wide text-stone-500">Event</h3>
                  <p class="text-sm font-semibold break-words">${esc(c.name || 'Unnamed tournament')}</p>
                  <p class="text-xs text-stone-500">${esc(c.date || 'Date not set')}${c.venue ? ` · ${esc(c.venue)}` : ''}</p>
                  <p class="text-xs text-stone-500">${c.rules ? 'Event-specific rules added' : 'No additional event rules'}</p>
                </article>
                <article class="rounded-lg border border-stone-200 dark:border-stone-700 p-3 space-y-2">
                  <h3 class="text-xs font-bold uppercase tracking-wide text-stone-500">Format &amp; scoring</h3>
                  <p class="text-xs">${state.groups.length} groups · ${totalPlayers} players · Round 1: ${esc(c.matchesPerPlayer)} matches per player</p>
                  <p class="text-xs">Games to ${c.pointsToWin}, win by two until ${c.deuceCap}</p>
                  <p class="text-xs">${round2GroupKeys.length} Round 2 groups · all players seeded by global WP rank</p>
                  <p class="text-xs">Round 2 matches per player: ${esc(c.qr2MatchesPerPlayer ?? c.matchesPerPlayer)}</p>
                  <p class="text-xs">Top 8 from each Round 2 group advance to its semi-finals</p>
                  <p class="text-xs">${round2GroupKeys.map(key => `Group ${key}: ${getPoolFinalFormat(key) === 'bo3' ? '3 sets' : '1 set'}`).join(' · ')}</p>
                </article>
                <article class="rounded-lg border border-stone-200 dark:border-stone-700 p-3 space-y-2 sm:col-span-2">
                  <h3 class="text-xs font-bold uppercase tracking-wide text-stone-500">Ranking &amp; tiebreakers</h3>
                  <p class="text-xs">${esc(getRankingFormulaText())}</p>
                  <p class="text-xs text-stone-500">${esc(getTiebreakerText())}</p>
                </article>
              </div>
              <div class="space-y-2">
                <h3 class="text-xs font-bold uppercase tracking-wide text-stone-500">Group readiness</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  ${state.groups.map(group => {
                    const ready = group.players.length >= 4 && group.leader && group.players.includes(group.leader);
                    return `<div class="flex items-center justify-between gap-2 rounded-lg border ${ready ? 'border-emerald-500/30' : 'border-red-500/40'} px-3 py-2 text-xs">
                      <span class="min-w-0 truncate font-semibold">${esc(group.name)}</span>
                      <span class="shrink-0 text-stone-500">${group.players.length} players · ${esc(group.leader || 'No leader')}</span>
                      <span class="${ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}">${ready ? 'Ready' : 'Needs attention'}</span>
                    </div>`;
                  }).join('')}
                </div>
              </div>
              ${setupReady ? `
                <p class="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">Your roster is ready to generate a schedule.</p>
              ` : `
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-3 py-2">
                  <p class="text-xs text-amber-700 dark:text-amber-400">${invalidGroup ? `${esc(invalidGroup.name)} needs at least 4 players and a group leader.` : scheduleError ? esc(scheduleError) : 'Add at least two groups before starting.'}</p>
                  <button type="button" data-setup-step-nav="${invalidGroup || !scheduleError ? 3 : 2}" class="min-h-11 rounded-lg border border-amber-500/30 px-3 py-2 text-xs font-semibold text-amber-700 dark:text-amber-400">${invalidGroup || !scheduleError ? 'Review players &amp; groups' : 'Review format &amp; scoring'}</button>
                </div>
              `}
            </section>

            <div class="sticky bottom-0 z-10 -mx-4 sm:-mx-6 border-t border-stone-200 dark:border-stone-800 bg-cream-50/95 dark:bg-[#111214]/95 px-4 sm:px-6 py-3 backdrop-blur">
              <div class="max-w-7xl mx-auto flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
                <button type="button" data-setup-step-nav="${Math.max(1, setupStep - 1)}" ${setupStep === 1 ? 'disabled' : ''} class="min-h-11 w-full sm:w-auto rounded-lg border border-stone-300 dark:border-stone-700 px-4 py-2 text-sm font-semibold disabled:opacity-40">Back</button>
                ${setupStep < setupSteps.length ? `
                  <div class="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span class="hidden sm:inline text-xs text-stone-500">Changes save automatically</span>
                    <button type="button" data-setup-step-nav="${setupStep + 1}" class="min-h-11 w-full sm:w-auto rounded-lg bg-gold-500 px-5 py-2 text-sm font-bold text-stone-950 hover:bg-gold-400">Continue to ${esc(setupSteps[setupStep].title)} <span aria-hidden="true">→</span></button>
                  </div>
                ` : `
                  <button type="button" id="start-tournament-btn" ${setupReady ? '' : 'disabled'} class="min-h-11 w-full sm:w-auto rounded-lg bg-gold-500 px-5 py-2 text-sm font-bold text-stone-950 shadow-md transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50">
                    Start Tournament — Generate QR1 Schedule
                  </button>
                `}
              </div>
            </div>
          </div>
        `;
      }

      function renderStandingsTable(title, players, matches, highlightTopN, accentClass, wpFirst = false, description = '') {
        const rows = computeStandings(players, matches, wpFirst);
        return `
          <details data-standings="${esc(title)}" class="group rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 overflow-hidden">
            <summary class="px-4 py-3 flex items-center justify-between gap-3 cursor-pointer list-none">
              <span class="font-bold text-sm ${accentClass || ''}">${esc(title)}</span>
              <span class="flex items-center gap-2">
                ${highlightTopN ? `<span class="text-[11px] text-stone-500 dark:text-stone-400">Top ${highlightTopN} advance</span>` : ''}
                <span aria-hidden="true" class="text-stone-500 transition-transform group-open:rotate-180">▾</span>
              </span>
            </summary>
            <div class="overflow-x-auto border-t border-stone-200 dark:border-stone-800">
              ${description ? `<p class="px-4 pt-3 text-xs text-stone-500">${esc(description)}</p>` : ''}
              <table class="w-full text-xs sm:text-sm text-left">
                <thead class="bg-cream-100/70 dark:bg-stone-800/60 text-stone-500 dark:text-stone-400 text-[11px] uppercase">
                  <tr>
                    <th class="px-3 py-2">#</th>
                    <th class="px-3 py-2">Player</th>
                    <th class="px-2 py-2 text-center">P</th>
                    <th class="px-2 py-2 text-center">W</th>
                    <th class="px-2 py-2 text-center">L</th>
                    <th class="px-2 py-2 text-center">PF</th>
                    <th class="px-2 py-2 text-center">PA</th>
                    <th class="px-3 py-2 text-right">WP</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-stone-100 dark:divide-stone-800/70 tabular-nums">
                  ${rows.map((r, idx) => {
                    const isTop = highlightTopN && idx < highlightTopN;
                    return `
                      <tr class="${isTop ? 'bg-gold-500/5' : ''}">
                        <td class="px-3 py-2 font-semibold ${isTop ? 'text-gold-600 dark:text-gold-400' : 'text-stone-400'}">${idx + 1}</td>
                        <td class="px-3 py-2 font-medium">
                          ${esc(r.player)}
                          <span class="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 font-semibold" title="Skill level">${getPlayerSkill(r.player)}</span>
                          ${r.tiedFlag ? `<span title="Tied on all tiebreakers — officiating table" class="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">TIE</span>` : ''}
                        </td>
                        <td class="px-2 py-2 text-center">${r.played}</td>
                        <td class="px-2 py-2 text-center text-emerald-600 dark:text-emerald-400 font-medium">${r.wins}</td>
                        <td class="px-2 py-2 text-center text-stone-500">${r.losses}</td>
                        <td class="px-2 py-2 text-center">${r.pf}</td>
                        <td class="px-2 py-2 text-center">${r.pa}</td>
                        <td class="px-3 py-2 text-right font-bold">${r.wp}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </details>
        `;
      }

      function renderMatchCard(m, listKey, matchNumber) {
        const isAdmin = state.auth.role === 'admin';
        const p1Won = m.completed && m.s1 > m.s2;
        const p2Won = m.completed && m.s2 > m.s1;
        return `
          <details data-match="${esc(JSON.stringify([listKey, m.id]))}" class="group rounded-xl bg-white dark:bg-[#191B1F] border ${m.completed ? 'border-emerald-500/30' : 'border-stone-200 dark:border-stone-800'}">
            <summary class="p-3.5 flex items-center justify-between gap-2 cursor-pointer list-none text-[11px] text-stone-500 dark:text-stone-400">
              <span class="font-bold text-sm text-stone-900 dark:text-stone-100">Match ${matchNumber}</span>
              <div class="flex items-center gap-1">
                ${Number.isInteger(m.round) && Number.isInteger(m.court) ? `<span class="px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-300 font-medium">Court ${m.court}</span>` : ''}
                <span class="px-2 py-0.5 rounded-full font-medium ${m.completed ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-stone-100 dark:bg-stone-800 text-stone-500'}">${m.completed ? 'Completed' : 'Pending'}</span>
                <span aria-hidden="true" class="ml-1 transition-transform group-open:rotate-180">▾</span>
              </div>
            </summary>
            <div class="p-3.5 pt-0 space-y-2.5">
            <div class="font-mono text-[11px] text-stone-500 dark:text-stone-400">${esc(m.id)}</div>
            <div class="flex items-center justify-between gap-2">
              <div class="flex-1 min-w-0">
                <div class="text-sm font-semibold break-words ${p1Won ? 'text-emerald-600 dark:text-emerald-400' : ''}">${esc(m.p1 || m.t1)}</div>
                <div class="text-xs text-stone-400 my-0.5">vs</div>
                <div class="text-sm font-semibold break-words ${p2Won ? 'text-emerald-600 dark:text-emerald-400' : ''}">${esc(m.p2 || m.t2)}</div>
              </div>
              ${isAdmin ? `
                <div class="flex items-center gap-1.5">
                  <div class="flex flex-col gap-1">
                    <input data-score-input="${listKey}:${m.id}:1" aria-label="Score for ${esc(m.p1 || m.t1)}" type="number" min="0" max="${state.config.deuceCap}" value="${m.s1 !== null ? m.s1 : ''}" placeholder="0"
                      class="w-14 px-2 py-1 text-center rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm font-bold tabular-nums" />
                    <input data-score-input="${listKey}:${m.id}:2" aria-label="Score for ${esc(m.p2 || m.t2)}" type="number" min="0" max="${state.config.deuceCap}" value="${m.s2 !== null ? m.s2 : ''}" placeholder="0"
                      class="w-14 px-2 py-1 text-center rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm font-bold tabular-nums" />
                  </div>
                  <button data-save-match="${listKey}:${m.id}" class="px-2.5 py-2 rounded-lg bg-gold-500 hover:bg-gold-400 text-stone-950 text-xs font-bold transition">Save</button>
                </div>
              ` : `
                <div class="flex flex-col items-end gap-1 font-bold text-base tabular-nums">
                  <span>${m.s1 !== null ? m.s1 : '—'}</span>
                  <span>${m.s2 !== null ? m.s2 : '—'}</span>
                </div>
              `}
            </div>
          </div>
          </details>
        `;
      }

      function renderScheduledMatchCards(matches, listKey, groupName, emptyMessage) {
        if (!matches.length) return emptyMessage || '';
        const rounds = new Map();
        const unassigned = [];
        matches.forEach(match => {
          if (!Number.isInteger(match.round) || !Number.isInteger(match.court)) {
            unassigned.push(match);
            return;
          }
          const roundMatches = rounds.get(match.round) || [];
          roundMatches.push(match);
          rounds.set(match.round, roundMatches);
        });

        let matchNumber = 0;
        const scheduled = [...rounds.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, roundMatches]) => `
            <section class="space-y-2">
              ${roundMatches.length > 1 ? '<div class="text-[11px] font-semibold text-stone-500">Parallel courts · no player overlap</div>' : ''}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                ${[1, 2].map(court => {
                  const match = roundMatches.find(item => item.court === court);
                  return match
                    ? renderMatchCard(match, listKey, ++matchNumber)
                    : `<div class="rounded-xl border border-dashed border-stone-300 dark:border-stone-700 p-3.5 text-xs text-stone-400">Court ${court} · no compatible match in this slot</div>`;
                }).join('')}
              </div>
            </section>
          `).join('');
        const legacy = unassigned.length
          ? `<section class="space-y-2"><p class="text-[11px] text-stone-500">Saved matches without court assignments; regenerate this schedule to create parallel court slots.</p><div class="grid grid-cols-1 md:grid-cols-2 gap-3">${unassigned.map(match => renderMatchCard(match, listKey, ++matchNumber)).join('')}</div></section>`
          : '';
        return `
          <section data-match-group="${esc(groupName)}" class="space-y-3" aria-label="${esc(groupName)} matches">
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-sm font-bold">${esc(groupName)} Matches</h3>
              <button type="button" data-match-toggle-all class="min-h-11 px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold hover:bg-cream-100 dark:hover:bg-stone-800">Expand all matches</button>
            </div>
            ${scheduled}${legacy}
          </section>
        `;
      }

      function renderQR1View() {
        if (state.qr1Matches.length === 0) {
          return renderEmptyState('No schedule yet', 'Complete setup and start the tournament to generate the Qualifier Round 1 schedule.');
        }
        const isAdmin = state.auth.role === 'admin';
        const filter = state.ui.qr1GroupFilter;
        const visibleGroups = filter === 'ALL' ? state.groups : state.groups.filter(g => g.id === filter);
        const allDone = state.qr1Matches.every(m => m.completed);
        const round2Exists = Object.values(state.qr2Pools || {}).some(players => players.length);

        return `
          <div class="space-y-6">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-1.5">
                <button data-qr1-filter="ALL" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${filter === 'ALL' ? 'bg-gold-500 text-stone-950' : 'bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800'}">All Groups</button>
                ${state.groups.map(g => `
                  <button data-qr1-filter="${g.id}" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${filter === g.id ? 'bg-gold-500 text-stone-950' : 'bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800'}">${esc(g.name)}</button>
                `).join('')}
              </div>
              ${isAdmin ? `
                <div class="flex items-center gap-2">
                  ${!allDone ? `<button id="sim-qr1-btn" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800">Simulate Remaining</button>` : ''}
                  <button id="advance-qr2-btn" ${allDone && !round2Exists ? '' : 'disabled'} class="px-4 py-1.5 rounded-lg text-xs font-bold transition ${allDone && !round2Exists ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-stone-300 dark:bg-stone-800 text-stone-500 cursor-not-allowed'}">
                    ${round2Exists ? 'Round 2 scheduled' : 'Advance to QR2 →'}
                  </button>
                </div>
              ` : ''}
            </div>

            <section class="space-y-2" aria-label="Overall Round 1 standings">
              ${renderStandingsTable('Overall Round 1 Standings', state.groups.flatMap(group => group.players), state.qr1Matches, 0, 'text-gold-600 dark:text-gold-400', true, 'All Round 1 groups combined, ranked by WP first. Round 2 assignment uses the configured ranking order.')}
            </section>

            ${visibleGroups.map(g => {
              const gMatches = state.qr1Matches.filter(m => m.groupId === g.id);
              return `
                <div class="space-y-3">
                ${renderStandingsTable(`${g.name} Standings`, g.players, gMatches, 0, 'text-gold-600 dark:text-gold-400')}
                  ${renderScheduledMatchCards(gMatches, 'qr1', g.name)}
                </div>
              `;
            }).join('')}
          </div>
        `;
      }

      function renderQR2View() {
        const poolKeys = Object.keys(state.qr2Pools || {});
        const hasAnyMatches = poolKeys.some(k => (state.qr2Matches[k] || []).length > 0 || (state.qr2Pools[k] || []).length > 0);
        if (!hasAnyMatches) {
          return renderEmptyState('Waiting on Qualifier Round 1', 'Round 2 groups are formed once every QR1 match is recorded and the round is advanced.');
        }
        const isAdmin = state.auth.role === 'admin';
        const allMatches = poolKeys.flatMap(k => state.qr2Matches[k] || []);
        const allDone = allMatches.length > 0 && allMatches.every(m => m.completed);
        const hasLaterSchedules = Object.values(state.semis || {}).some(matches => matches.length) ||
          Object.values(state.finals || {}).some(Boolean);
        const hasMissingSemis = poolKeys.some(k => (state.qr2Pools[k] || []).length && !(state.semis[k] || []).length);

        return `
          <div class="space-y-6">
            ${isAdmin ? `
              <div class="flex flex-wrap items-center justify-between gap-2">
                <button id="add-qr2-pool-btn" ${hasLaterSchedules ? 'disabled title="Later schedules exist"' : ''} class="px-3.5 py-1.5 rounded-lg bg-gold-500/15 hover:bg-gold-500/25 text-gold-600 dark:text-gold-400 border border-gold-500/30 text-xs font-semibold transition disabled:opacity-50">
                  + Add Group
                </button>
                <div class="flex items-center gap-2">
                  ${!allDone && allMatches.length > 0 ? `<button id="sim-qr2-btn" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800">Simulate Remaining</button>` : ''}
                  <button id="advance-semis-btn" ${allDone && hasMissingSemis ? '' : 'disabled'} class="px-4 py-1.5 rounded-lg text-xs font-bold transition ${allDone && hasMissingSemis ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-stone-300 dark:bg-stone-800 text-stone-500 cursor-not-allowed'}">
                    ${hasMissingSemis ? 'Advance to Semi-Finals →' : 'Semi-finals scheduled'}
                  </button>
                </div>
              </div>
            ` : ''}

            ${poolKeys.map((k, idx) => {
              const players = state.qr2Pools[k] || [];
              const matches = state.qr2Matches[k] || [];
              return `
                <div class="space-y-4 ${idx > 0 ? 'pt-4 border-t border-stone-200 dark:border-stone-800' : ''}">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="text-xs text-stone-500 dark:text-stone-400">${players.length} players · ${matches.length} matches</span>
                    ${isAdmin ? `
                      <div class="flex items-center gap-2">
                        <button data-regen-pool="${k}" ${hasLaterSchedules ? 'disabled title="Later schedules exist"' : ''} class="px-2.5 py-1 rounded-lg border border-stone-300 dark:border-stone-700 text-[11px] font-medium hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50">Regenerate Schedule</button>
                        ${poolKeys.length > 2 ? `<button data-remove-pool="${k}" ${hasLaterSchedules ? 'disabled title="Later schedules exist"' : ''} class="px-2.5 py-1 rounded-lg border border-red-300 dark:border-red-900/60 text-red-600 dark:text-red-400 text-[11px] font-medium hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50">Remove Group ${k}</button>` : ''}
                      </div>
                    ` : ''}
                  </div>
                  <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 space-y-2" aria-label="Group ${esc(k)} Round 2 qualifiers">
                    <h3 class="font-bold text-sm ${getPoolAccent(k)}">Group ${esc(k)} Semi-Final Qualifiers</h3>
                    ${players.length < 8 ? '<p class="text-xs text-stone-500">At least 8 players are needed to qualify for the semi-finals.</p>' :
                      !matches.length || matches.some(match => !match.completed) ? '<p class="text-xs text-stone-500">Qualifiers will appear when all matches in this group are complete.</p>' : `
                        <p class="text-xs text-stone-500">Top 8 by the configured group ranking. Ties are flagged for the officiating table.</p>
                        <ol class="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
                          ${computeStandings(players, matches).slice(0, 8).map((row, index) => `
                            <li class="flex justify-between gap-3"><span>${index + 1}. ${esc(row.player)}${row.tiedFlag ? ' <span class="text-amber-500 font-semibold">TIE</span>' : ''}</span><span class="tabular-nums">${esc(row.wp)} WP</span></li>
                          `).join('')}
                        </ol>
                      `}
                  </section>
                  ${renderStandingsTable(`Round 2 Group ${k} Standings (Top 8 → Group ${k} Semi-Finals)`, players, matches, 8, getPoolAccent(k))}
                  ${renderScheduledMatchCards(matches, `qr2_${k}`, `Group ${k}`, `<div class="text-xs text-stone-500 italic">No matches generated yet for Group ${esc(k)} (needs at least 4 players).</div>`)}
                </div>
              `;
            }).join('')}
          </div>
        `;
      }

      function renderSemisView() {
        const poolKeys = Object.keys(state.semis || {}).filter(k => (state.semis[k] || []).length > 0);
        if (poolKeys.length === 0) {
          return renderEmptyState('Semi-Finals not set', 'Finish Qualifier Round 2 and advance the top 8 from each group to its semi-final matches.');
        }
        const isAdmin = state.auth.role === 'admin';
        const allMatches = poolKeys.flatMap(k => state.semis[k] || []);
        const expectedPools = getActiveQR2PoolKeys().filter(k => (state.qr2Pools[k] || []).length > 0);
        const allDone = expectedPools.length > 0 && expectedPools.every(k =>
          (state.semis[k] || []).length >= 2 && state.semis[k].every(m => m.completed)
        );
        const hasMissingFinals = expectedPools.some(k => !state.finals[k]);

        return `
          <div class="space-y-6">
            ${isAdmin ? `
              <div class="flex items-center justify-end gap-2">
                ${allMatches.some(m => !m.completed) ? `<button id="sim-semis-btn" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800">Simulate Remaining</button>` : ''}
                <button id="advance-finals-btn" ${allDone && hasMissingFinals ? '' : 'disabled'} class="px-4 py-1.5 rounded-lg text-xs font-bold transition ${allDone && hasMissingFinals ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-stone-300 dark:bg-stone-800 text-stone-500 cursor-not-allowed'}">
                  ${hasMissingFinals ? 'Advance to Finals →' : 'Finals scheduled'}
                </button>
              </div>
            ` : ''}

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              ${poolKeys.map(k => `
                <div class="space-y-3">
                  <h2 class="text-sm font-bold ${getPoolAccent(k)} uppercase tracking-wider">Group ${k} Semi-Finals</h2>
                  ${renderScheduledMatchCards(state.semis[k], `semi_${k}`, `Group ${k}`)}
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }

      function renderFinalsView() {
        const finalKeys = Object.keys(state.finals || {}).filter(k => Boolean(state.finals[k]));
        if (finalKeys.length === 0) {
          return renderEmptyState('Finals not set', 'Complete both semi-final matches in each Round 2 group to unlock its final.');
        }
        const isAdmin = state.auth.role === 'admin';

        const renderFinalCard = (f, poolKey, accent) => {
          if (!f) return '';
          return `
            <details data-match="${esc(JSON.stringify(['final', poolKey]))}" class="group rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800">
              <summary class="p-5 flex items-center justify-between gap-3 cursor-pointer list-none">
                <span>
                  <span class="block font-bold text-base ${accent}">Group ${esc(poolKey)} Final</span>
                  <span class="block text-xs text-stone-500 dark:text-stone-400">${f.format === 'bo3' ? 'Best of 3 Games' : 'Single Game'}</span>
                </span>
                <span class="flex items-center gap-2">
                  ${f.completed ? `<span class="px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-xs font-bold">Champion: ${esc(f.winner)}</span>` : ''}
                  <span aria-hidden="true" class="text-stone-500 transition-transform group-open:rotate-180">▾</span>
                </span>
              </summary>
              <div class="px-5 pb-5 space-y-4">
              <div class="p-3 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 flex items-center justify-between text-sm font-semibold">
                <span class="${f.winner === f.t1 ? 'text-emerald-500' : ''}">${esc(f.t1)}</span>
                <span class="text-xs text-stone-400 px-2">VS</span>
                <span class="${f.winner === f.t2 ? 'text-emerald-500' : ''}">${esc(f.t2)}</span>
              </div>

              <div class="space-y-2">
                ${f.games.map((g, gi) => `
                  <div class="flex items-center justify-between gap-2 text-xs">
                    <span class="font-medium text-stone-500">Game ${gi + 1}</span>
                    ${isAdmin ? `
                      <div class="flex items-center gap-2">
                        <input data-final-input="${poolKey}:${gi}:1" aria-label="Game ${gi + 1} score for ${esc(f.t1)}" type="number" min="0" max="${state.config.deuceCap}" value="${g.s1 !== null ? g.s1 : ''}" placeholder="0" class="w-14 px-2 py-1 text-center rounded bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 font-bold tabular-nums" />
                        <span>–</span>
                        <input data-final-input="${poolKey}:${gi}:2" aria-label="Game ${gi + 1} score for ${esc(f.t2)}" type="number" min="0" max="${state.config.deuceCap}" value="${g.s2 !== null ? g.s2 : ''}" placeholder="0" class="w-14 px-2 py-1 text-center rounded bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 font-bold tabular-nums" />
                      </div>
                    ` : `
                      <span class="font-bold tabular-nums">${g.s1 !== null ? `${g.s1} – ${g.s2}` : '—'}</span>
                    `}
                  </div>
                `).join('')}
              </div>

              ${isAdmin ? `<button data-save-final="${poolKey}" class="w-full py-2 rounded-lg bg-gold-500 hover:bg-gold-400 text-stone-950 font-bold text-xs transition">Save Group ${poolKey} Final</button>` : ''}
              </div>
            </details>
          `;
        };

        const readyToComplete = isAdmin && TournamentDraw.isTournamentReadyToComplete(state);
        return `
          <div class="space-y-5">
            ${isAdmin && state.phase !== 'completed' ? `
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 flex flex-wrap items-center justify-between gap-3">
                <p class="text-xs text-stone-500">${readyToComplete ? 'All matches are complete. Mark the tournament done to move it to Past Tournaments and close player check-in.' : 'Complete all qualifying matches, semi-finals, and finals before marking the tournament done.'}</p>
                <button id="complete-tournament-btn" type="button" ${readyToComplete ? '' : 'disabled'} class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed">Mark Tournament Done</button>
              </div>
            ` : ''}
            ${state.phase === 'completed' ? `<p class="text-sm font-semibold text-emerald-600 dark:text-emerald-400">Tournament ${state.closedEarly ? 'closed' : 'marked done'}. Find it under Past Tournaments.</p>` : ''}
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              ${finalKeys.map(k => renderFinalCard(state.finals[k], k, getPoolAccent(k))).join('')}
            </div>
          </div>
        `;
      }

      function renderDashboardView() {
        const s = getStatsSummary();
        const c = state.config;
        const phaseLabels = {
          setup: 'Setup',
          qr1: 'Qualifier Round 1',
          qr2: 'Qualifier Round 2',
          semis: 'Semi-Finals',
          finals: 'Finals',
          completed: 'Completed'
        };
        const configuredGroupKeys = getConfiguredPoolKeys();
        const activeGroupKeys = Object.keys(state.qr2Pools || {}).filter(key =>
          (state.qr2Pools[key] || []).length > 0 || (state.qr2Matches[key] || []).length > 0
        );
        const dashboardGroupKeys = activeGroupKeys.length ? activeGroupKeys : configuredGroupKeys;
        const semifinalGroupKeys = Object.keys(state.semis || {}).filter(key => (state.semis[key] || []).length > 0);
        const existingFinalKeys = Object.keys(state.finals || {}).filter(key => Boolean(state.finals[key]));
        const finalsFormatKeys = existingFinalKeys.length ? existingFinalKeys : dashboardGroupKeys;
        const round2Summary = activeGroupKeys.length
          ? `${activeGroupKeys.length} groups · ${activeGroupKeys.map(key => `Group ${key}: ${(state.qr2Pools[key] || []).length} players`).join(' · ')}`
          : `${configuredGroupKeys.length} groups configured · awaiting Round 1 results`;
        const semifinalSummary = semifinalGroupKeys.length
          ? `${semifinalGroupKeys.length} groups · ${s.semiTotal} matches`
          : `${dashboardGroupKeys.length} groups · top 8 qualify per group`;
        const finalsSummary = finalsFormatKeys
          .map(key => `Group ${key}: ${getPoolFinalFormat(key) === 'bo3' ? '3 sets' : '1 set'}`)
          .join(' · ');
        const roundStatus = (done, total, activePhase) => {
          if (total > 0 && done === total) return '<span class="px-2 py-0.5 rounded-full text-[11px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">Completed</span>';
          if (state.phase === activePhase || total > 0) return '<span class="px-2 py-0.5 rounded-full text-[11px] bg-gold-500/15 text-gold-600 dark:text-gold-400 font-medium">In Progress</span>';
          return '<span class="px-2 py-0.5 rounded-full text-[11px] bg-stone-100 dark:bg-stone-800 text-stone-500 font-medium">Pending</span>';
        };

        return `
          <div class="space-y-6">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <p class="text-[10px] font-bold uppercase tracking-[0.16em] text-gold-600 dark:text-gold-400">Live tournament dashboard</p>
                <h1 class="mt-1 text-xl sm:text-2xl font-extrabold">${esc(c.name || 'Tournament')}</h1>
                <p class="mt-1 text-xs text-stone-500 dark:text-stone-400">${[c.date, c.venue].filter(Boolean).map(esc).join(' · ') || 'Date and venue not set'}</p>
              </div>
              <span class="self-start sm:self-auto px-3 py-1 rounded-full text-xs font-semibold ${state.phase === 'completed' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-gold-500/15 text-gold-600 dark:text-gold-400'}">${esc(state.phase === 'completed' && state.closedEarly ? 'Closed' : phaseLabels[state.phase] || state.phase)}</span>
            </div>

            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4">
                <div class="text-xs font-semibold uppercase tracking-wider text-stone-500">Players</div>
                <div class="text-2xl font-extrabold mt-1 tabular-nums">${s.totalPlayers}</div>
              </div>
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4">
                <div class="text-xs font-semibold uppercase tracking-wider text-stone-500">Round 1 Groups</div>
                <div class="text-2xl font-extrabold mt-1 tabular-nums">${state.groups.length}</div>
              </div>
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4">
                <div class="text-xs font-semibold uppercase tracking-wider text-stone-500">Matches Played</div>
                <div class="text-2xl font-extrabold mt-1 tabular-nums">${s.done}/${s.total || '—'}</div>
              </div>
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4">
                <div class="text-xs font-semibold uppercase tracking-wider text-stone-500">Progress</div>
                <div class="text-2xl font-extrabold mt-1 text-gold-600 dark:text-gold-400 tabular-nums">${s.pct}%</div>
              </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-5 space-y-4">
                <div class="flex items-center justify-between">
                  <h2 class="font-bold text-base">Tournament Progress</h2>
                  <span class="text-xs text-stone-500 tabular-nums">${s.done} of ${s.total} matches recorded</span>
                </div>
                <div class="divide-y divide-stone-100 dark:divide-stone-800 text-sm">
                  <a href="${esc(getPageUrl('qr1'))}" data-tab="qr1" class="py-3 flex items-center justify-between gap-3 rounded hover:bg-cream-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold-500">
                    <div><div class="font-semibold">Qualifier Round 1</div><div class="text-xs text-stone-500">${state.groups.length} groups · ${s.totalPlayers} rostered · ${c.playersPerGroup} target/group</div></div>
                    <div class="flex items-center gap-3"><span class="text-xs tabular-nums text-stone-500">${s.qr1Done}/${s.qr1Total}</span>${roundStatus(s.qr1Done, s.qr1Total, 'qr1')}<span aria-hidden="true" class="text-stone-400">→</span></div>
                  </a>
                  <a href="${esc(getPageUrl('qr2'))}" data-tab="qr2" class="py-3 flex items-center justify-between gap-3 rounded hover:bg-cream-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold-500">
                    <div><div class="font-semibold">Qualifier Round 2</div><div class="text-xs text-stone-500">${round2Summary}</div></div>
                    <div class="flex items-center gap-3"><span class="text-xs tabular-nums text-stone-500">${s.qr2Done}/${s.qr2Total}</span>${roundStatus(s.qr2Done, s.qr2Total, 'qr2')}<span aria-hidden="true" class="text-stone-400">→</span></div>
                  </a>
                  <a href="${esc(getPageUrl('semis'))}" data-tab="semis" class="py-3 flex items-center justify-between gap-3 rounded hover:bg-cream-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold-500">
                    <div><div class="font-semibold">Semi-Finals</div><div class="text-xs text-stone-500">${semifinalSummary}</div></div>
                    <div class="flex items-center gap-3"><span class="text-xs tabular-nums text-stone-500">${s.semiDone}/${s.semiTotal}</span>${roundStatus(s.semiDone, s.semiTotal, 'semis')}<span aria-hidden="true" class="text-stone-400">→</span></div>
                  </a>
                  <a href="${esc(getPageUrl('finals'))}" data-tab="finals" class="py-3 flex items-center justify-between gap-3 rounded hover:bg-cream-100 dark:hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold-500">
                    <div><div class="font-semibold">Finals</div><div class="text-xs text-stone-500">${finalsSummary}</div></div>
                    <div class="flex items-center gap-3"><span class="text-xs tabular-nums text-stone-500">${s.finalDone}/${s.finalTotal}</span>${roundStatus(s.finalDone, s.finalTotal, 'finals')}<span aria-hidden="true" class="text-stone-400">→</span></div>
                  </a>
                </div>
              </div>

              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-5 space-y-4">
                <h2 class="font-bold text-base">Tournament Settings &amp; Ranking Rules</h2>
                <div class="p-3.5 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 space-y-1.5 text-xs sm:text-sm">
                  <div class="font-mono font-semibold text-gold-600 dark:text-gold-400">${esc(getRankingFormulaText())}</div>
                  <p class="text-xs text-stone-500 dark:text-stone-400">Order: ${esc(getTiebreakerText())} · still tied → flagged for the officiating table.</p>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1">
                  <div class="p-3 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800">
                    <div class="text-[11px] text-stone-500 uppercase">Game To</div>
                    <div class="font-bold text-sm mt-0.5">${c.pointsToWin} pts</div>
                  </div>
                  <div class="p-3 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800">
                    <div class="text-[11px] text-stone-500 uppercase">Deuce Cap</div>
                    <div class="font-bold text-sm mt-0.5">${c.deuceCap}</div>
                  </div>
                  <div class="p-3 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800">
                    <div class="text-[11px] text-stone-500 uppercase">Round 2 Groups</div>
                    <div class="font-bold text-sm mt-0.5">${configuredGroupKeys.length} groups</div>
                  </div>
                  <div class="p-3 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800">
                    <div class="text-[11px] text-stone-500 uppercase">Matches / Player</div>
                    <div class="font-bold text-sm mt-0.5">${c.matchesPerPlayer}</div>
                  </div>
                  <div class="p-3 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800">
                    <div class="text-[11px] text-stone-500 uppercase">Semi-Finals</div>
                    <div class="font-bold text-sm mt-0.5">Top 8 per group</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;
      }

      function renderTournamentCatalogView() {
        const isPast = tournament => {
          const phase = tournament.phase || tournament.data?.phase || 'setup';
          return phase === 'completed';
        };
        const currentTournaments = tournamentCatalog.items.filter(tournament => !isPast(tournament));
        const pastTournaments = tournamentCatalog.items.filter(isPast)
          .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
        const phaseLabels = {
          setup: 'Setup',
          qr1: 'Qualifier Round 1',
          qr2: 'Qualifier Round 2',
          semis: 'Semi-Finals',
          finals: 'Finals',
          completed: 'Completed'
        };
        const renderTournamentCard = tournament => {
          const data = tournament.data || {};
          const config = data.config || {};
          const groups = Array.isArray(data.groups) ? data.groups : [];
          const players = new Set(groups.flatMap(group => Array.isArray(group.players) ? group.players : []));
          Object.values(data.qr2Pools || {}).flat().forEach(name => players.add(name));
          const matches = [
            ...(Array.isArray(data.qr1Matches) ? data.qr1Matches : []),
            ...Object.values(data.qr2Matches || {}).flat(),
            ...Object.values(data.semis || {}).flat(),
            ...Object.values(data.finals || {}).filter(Boolean)
          ];
          const completedMatches = matches.filter(match => match.completed).length;
          const phase = tournament.phase || data.phase || 'setup';
          const date = tournament.date || config.date || '';
          const dateLabel = date
            ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            : 'Date not set';
          const selected = String(tournament.id) === String(state.tournamentId);
          const tournamentName = tournament.name || config.name || 'Tournament';
          return `
            <article class="rounded-xl bg-white dark:bg-[#191B1F] border ${selected ? 'border-gold-500/50 ring-1 ring-gold-500/20' : 'border-stone-200 dark:border-stone-800'} p-4 sm:p-5 space-y-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="font-bold text-base truncate">${esc(tournamentName)}</h3>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${phase === 'completed' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-gold-500/15 text-gold-700 dark:text-gold-300'}">${esc(phase === 'completed' && (tournament.closedEarly || data.closedEarly) ? 'Closed' : phaseLabels[phase] || phase)}</span>
                    ${selected ? '<span class="text-[10px] font-semibold text-gold-700 dark:text-gold-300">Selected</span>' : ''}
                  </div>
                  <p class="text-xs text-stone-500 mt-1">${esc(dateLabel)}${(tournament.venue || config.venue) ? ` · ${esc(tournament.venue || config.venue)}` : ''}</p>
                  <p class="text-xs text-stone-500 mt-1">Tournament ID: ${esc(tournament.id)}</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button type="button" data-open-tournament="${esc(tournament.id)}" class="shrink-0 px-3 py-2 rounded-lg bg-gold-500 hover:bg-gold-400 text-stone-950 text-xs font-bold">${selected ? 'Open tournament' : 'View tournament'}</button>
                  ${state.auth.role === 'admin'
                    ? `<button type="button" data-delete-tournament="${esc(tournament.id)}" data-tournament-name="${esc(tournamentName)}" aria-label="Delete ${esc(tournamentName)}" class="shrink-0 px-3 py-2 rounded-lg border border-red-300 dark:border-red-900/60 text-red-600 dark:text-red-400 text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-950/30">Delete</button>`
                    : ''}
                </div>
              </div>
              <div class="grid grid-cols-3 gap-2 border-t border-stone-100 dark:border-stone-800 pt-3">
                <div><div class="text-[10px] uppercase tracking-wide text-stone-500">Players</div><div class="mt-1 text-sm font-bold tabular-nums">${tournament.stats?.players ?? (players.size || groups.reduce((sum, group) => sum + (group.players?.length || 0), 0))}</div></div>
                <div><div class="text-[10px] uppercase tracking-wide text-stone-500">Groups</div><div class="mt-1 text-sm font-bold tabular-nums">${tournament.stats?.groups ?? (groups.length || config.numGroups || 0)}</div></div>
                <div><div class="text-[10px] uppercase tracking-wide text-stone-500">Matches</div><div class="mt-1 text-sm font-bold tabular-nums">${tournament.stats?.completedMatches ?? completedMatches}/${tournament.stats?.matches ?? matches.length}</div></div>
              </div>
            </article>
          `;
        };
        const section = (title, items, emptyText) => `
          <section class="space-y-3">
            <div class="flex items-center justify-between gap-3">
              <h2 class="text-sm font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">${title}</h2>
              <span class="text-[11px] text-stone-500">${items.length} event${items.length === 1 ? '' : 's'}</span>
            </div>
            ${items.length ? `<div class="grid grid-cols-1 xl:grid-cols-2 gap-3">${items.map(renderTournamentCard).join('')}</div>` : `<div class="rounded-xl border border-dashed border-stone-300 dark:border-stone-700 p-5 text-sm text-stone-500">${emptyText}</div>`}
          </section>
        `;

        return `
          <section class="space-y-6">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-600 dark:text-gold-400">Tournament library</p>
                <h1 class="mt-1 text-xl sm:text-2xl font-extrabold tracking-tight">Current &amp; Past Tournaments</h1>
                <p class="mt-1 text-sm text-stone-500 dark:text-stone-400">${state.auth.role === 'player' ? 'Browse current, ongoing, and past tournaments. Your profile controls are available on My Player Card.' : 'Open an event to view its schedule, standings, results, bracket, and rules.'}</p>
              </div>
              <div class="flex flex-wrap gap-2">
                ${state.auth.role === 'player' ? '<button id="player-profile-shortcut" class="px-3 py-2 rounded-lg bg-gold-500 hover:bg-gold-400 text-stone-950 text-xs font-bold">My Player Card</button>' : ''}
                <button id="tournament-history-refresh" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold hover:bg-stone-100 dark:hover:bg-stone-800">Refresh list</button>
                ${state.auth.role === 'admin' ? '<button id="new-tournament-btn" class="px-3 py-2 rounded-lg bg-gold-500 hover:bg-gold-400 text-stone-950 text-xs font-bold">+ New Tournament</button>' : ''}
              </div>
            </div>
            ${tournamentCatalog.error ? `<p role="status" class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">${esc(tournamentCatalog.error)} Previously loaded results may be stale.</p>` : ''}
            ${tournamentCatalog.loading ? '<p class="rounded-lg border border-stone-200 dark:border-stone-800 p-3 text-xs text-stone-500">Loading tournament history…</p>' : ''}
            ${tournamentCatalog.loaded && !tournamentCatalog.items.length ? renderEmptyState('No tournaments yet', 'Create a tournament or connect to a database to see saved events here.') : ''}
            ${section('Current & Upcoming', currentTournaments, 'No current or upcoming tournaments. Completed events are listed below.')}
            ${section('Past Tournaments', pastTournaments, 'Completed and previous events will appear here.')}
          </section>
        `;
      }

      function renderRulesView() {
        const config = state.config;
        const customRules = String(config.rules || '').trim();
        const poolKeys = getConfiguredPoolKeys();
        return `
          <section class="max-w-5xl mx-auto space-y-5">
            <div>
              <p class="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-600 dark:text-gold-400">${esc(config.name)}</p>
              <h1 class="mt-1 text-xl sm:text-2xl font-extrabold tracking-tight">Rules &amp; Tournament Format</h1>
              <p class="mt-1 text-sm text-stone-500 dark:text-stone-400">A quick guide for players, spectators, and organizers.</p>
            </div>
            <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-3">
              <h2 class="font-bold text-sm">Event-specific rules</h2>
              ${customRules
                ? `<div class="whitespace-pre-wrap text-sm leading-6 text-stone-600 dark:text-stone-300">${esc(customRules)}</div>`
                : '<p class="text-sm text-stone-500">The organizer has not added extra event rules. The scoring and tournament format below apply.</p>'}
            </section>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-3">
                <h2 class="font-bold text-sm">Match scoring</h2>
                <ul class="space-y-2 text-sm text-stone-600 dark:text-stone-300">
                  <li>Games are played to <b>${config.pointsToWin} points</b>.</li>
                  <li>Matches are doubles. Both teammates receive the same win or loss, points for and against, and ranking points.</li>
                  <li>Players must win by two points until the configured cap of <b>${config.deuceCap}</b>.</li>
                  <li>Scores that do not meet the event scoring rules cannot be saved.</li>
                </ul>
              </section>
              <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-3">
                <h2 class="font-bold text-sm">Tournament progression</h2>
                <ul class="space-y-2 text-sm text-stone-600 dark:text-stone-300">
                  <li><b>Qualifier 1:</b> ${config.numGroups} groups, up to ${config.playersPerGroup} players per group; ${esc(config.matchesPerPlayer)} doubles matches per player when newly scheduled, without repeated partners within a group.</li>
                  <li><b>Qualifier 2:</b> all players are ranked by WP and tie-breakers, then assigned to ${poolKeys.length} groups in consecutive rank blocks; ${esc(config.qr2MatchesPerPlayer ?? config.matchesPerPlayer)} matches per player when newly scheduled.</li>
                  <li><b>Semi-finals:</b> the top 8 players from each Round 2 group advance to that group's semi-finals.</li>
                  <li><b>Finals:</b> ${poolKeys.map(key => `Group ${key} ${getPoolFinalFormat(key) === 'bo3' ? 'best of three' : 'single game'}`).join('; ')}.</li>
                </ul>
              </section>
              <section class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-3 md:col-span-2">
                <h2 class="font-bold text-sm">Standings &amp; tie-breakers</h2>
                <p class="font-mono text-xs sm:text-sm text-gold-700 dark:text-gold-300">${esc(getRankingFormulaText())}</p>
                <p class="text-sm text-stone-600 dark:text-stone-300">Tie-break order: ${esc(getTiebreakerText())}. Players still tied on every configured metric are flagged for the officiating table.</p>
              </section>
            </div>
            ${state.auth.role === 'admin' ? '<p class="text-xs text-stone-500">To update event-specific rules, open Tournament → Setup and edit the rules section.</p>' : ''}
          </section>
        `;
      }

      function getPlayerAvatar(name, profile, size) {
        const dimensions = size || 'w-20 h-20';
        const displayName = profile?.displayName || name;
        const initials = String(displayName || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
        let photoUrl = '';
        try {
          const value = String(profile?.photoUrl || '');
          if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 900000) {
            photoUrl = value;
          } else {
            const parsed = new URL(value);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') photoUrl = parsed.href;
          }
        } catch (_err) {}
        return `
          <div class="${dimensions} relative shrink-0 rounded-full bg-gold-500/15 border border-gold-500/30 flex items-center justify-center text-gold-600 dark:text-gold-400 font-extrabold overflow-hidden">
            <span>${esc(initials)}</span>
            ${photoUrl ? `<img data-player-photo src="${esc(photoUrl)}" alt="${esc(displayName)}" class="absolute inset-0 w-full h-full object-cover" />` : ''}
          </div>
        `;
      }

      async function openGroupPlayerPicker(groupIndex) {
        let profiles;
        try {
          profiles = await getPlayerProfileDirectory();
        } catch (err) {
          showToast(`Could not load player profiles: ${err.message}`, 'error');
          return;
        }
        const group = state.groups[groupIndex];
        if (!group) return;
        const availableProfiles = profiles
          .filter(profile => profile && profile.name && isValidPlayerId(profile.playerId))
          .filter(profile => !isPlayerProfileInRoster(profile))
          .sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
        const selectedPlayerIds = new Set();
        openModal(`
          <div class="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-6 space-y-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[10px] uppercase tracking-[0.18em] font-bold text-gold-700 dark:text-gold-400">Player directory</p>
                <h3 class="mt-1 text-lg font-bold">Add players to ${esc(group.name)}</h3>
                <p class="mt-1 text-xs text-stone-500">Select one or more players. Profile skills are used initially; you can override them for this tournament.</p>
              </div>
              <span class="shrink-0 rounded-full bg-stone-100 dark:bg-[#111214] px-2.5 py-1 text-[10px] font-semibold text-stone-500">${availableProfiles.length} available</span>
            </div>
            ${availableProfiles.length ? `
              <label class="sr-only" for="group-profile-search">Search by name, player code, or club</label>
              <input id="group-profile-search" type="search" placeholder="Search name, 6-digit code, or club..." class="w-full px-4 py-3 rounded-xl bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm focus:outline-none focus:ring-2 focus:ring-gold-500/50" />
              <div id="group-profile-list" class="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[48vh] overflow-y-auto pr-1">
                ${availableProfiles.map(profile => `
                  <button type="button" data-group-profile-id="${esc(profile.playerId)}" data-profile-search="${esc(`${profile.displayName || profile.name} ${profile.playerCode || ''} ${profile.club || ''}`.toLocaleLowerCase())}" aria-pressed="false" class="group w-full flex items-center gap-3 rounded-xl border border-stone-200 dark:border-stone-700 hover:border-gold-500/60 p-3 text-left transition">
                    ${getPlayerAvatar(profile.displayName || profile.name, profile, 'w-11 h-11')}
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-bold">${esc(profile.displayName || profile.name)}</span>
                      <span class="mt-0.5 block truncate text-[11px] text-stone-500">${esc(profile.club || 'No club listed')}</span>
                    </span>
                    <span class="shrink-0 text-right">
                      <span class="block text-[9px] uppercase tracking-wide text-stone-400">Player code</span>
                      <span class="font-mono text-xs font-bold text-gold-700 dark:text-gold-400">${esc(profile.playerCode || 'Pending')}</span>
                    </span>
                  </button>
                `).join('')}
              </div>
              <p id="group-profile-empty-search" class="hidden rounded-xl bg-cream-50 dark:bg-[#111214] p-4 text-center text-xs text-stone-500">No profiles match that search. Try another name or code.</p>
            ` : '<div class="rounded-xl border border-dashed border-stone-300 dark:border-stone-700 bg-cream-50 dark:bg-[#111214] p-5 text-center"><p class="text-sm font-semibold">No unassigned profiles</p><p class="mt-1 text-xs text-stone-500">Create a profile first, then add it to this group.</p></div>'}
            <div class="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 border-t border-stone-200 dark:border-stone-800 pt-4">
              <button id="group-create-profile-btn" type="button" class="px-3 py-2.5 rounded-lg border border-gold-500/40 text-xs font-semibold text-gold-700 dark:text-gold-400 hover:bg-gold-500/10">Create new player profile</button>
              <div class="flex justify-end gap-2">
                <button id="group-player-picker-cancel" type="button" class="px-3 py-2.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
                <button id="group-player-picker-add" type="button" disabled class="px-4 py-2.5 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold disabled:opacity-50">Add selected players (0)</button>
              </div>
            </div>
          </div>
        `);
        document.getElementById('group-player-picker-cancel').addEventListener('click', closeModal);
        document.getElementById('group-create-profile-btn').addEventListener('click', () => {
          closeModal();
          renderPlayerProfileEditor(null, profile => addPlayerProfileToGroup(groupIndex, profile));
        });
        const search = document.getElementById('group-profile-search');
        const cards = [...document.querySelectorAll('[data-group-profile-id]')];
        const addButton = document.getElementById('group-player-picker-add');
        cards.forEach(card => card.addEventListener('click', () => {
          const playerId = card.getAttribute('data-group-profile-id');
          if (selectedPlayerIds.has(playerId)) selectedPlayerIds.delete(playerId);
          else selectedPlayerIds.add(playerId);
          const selected = selectedPlayerIds.has(playerId);
          card.setAttribute('aria-pressed', String(selected));
          card.classList.toggle('border-gold-500', selected);
          card.classList.toggle('border-stone-200', !selected);
          card.classList.toggle('dark:border-stone-700', !selected);
          card.classList.toggle('bg-gold-500/10', selected);
          card.classList.toggle('ring-1', selected);
          card.classList.toggle('ring-gold-500/30', selected);
          addButton.disabled = selectedPlayerIds.size === 0;
          addButton.textContent = `Add selected players (${selectedPlayerIds.size})`;
        }));
        search?.addEventListener('input', () => {
          const query = search.value.toLocaleLowerCase().trim();
          let visibleCount = 0;
          cards.forEach(card => {
            const visible = !query || card.getAttribute('data-profile-search').includes(query);
            card.classList.toggle('hidden', !visible);
            if (visible) visibleCount++;
          });
          document.getElementById('group-profile-empty-search').classList.toggle('hidden', visibleCount > 0);
        });
        document.getElementById('group-player-picker-add').addEventListener('click', () => {
          const selected = availableProfiles.filter(profile => selectedPlayerIds.has(profile.playerId));
          if (addPlayerProfilesToGroup(groupIndex, selected)) closeModal();
        });
      }

      function renderPlayerProfileEditor(profile, onSaved) {
        const current = profile || { name: '', photoUrl: '', age: '', club: '', ranking: '' };
        const editing = Boolean(current.name);
        openModal(`
          <form id="player-profile-form" class="w-full max-w-lg rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
            <div>
              <h3 class="text-base font-bold">${editing ? 'Edit Player Profile' : 'Add Player Profile'}</h3>
              <p class="text-xs text-stone-500 dark:text-stone-400 mt-1">Profiles are shared across tournaments. Ranking is maintained manually.</p>
              ${editing && current.playerCode ? `<p class="mt-2 text-xs font-mono font-bold text-gold-700 dark:text-gold-400">Player code: ${esc(current.playerCode)}</p>` : ''}
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div class="sm:col-span-2">
                <label for="profile-player-name" class="block font-semibold text-stone-500 mb-1">Player name</label>
                <input id="profile-player-name" type="text" maxlength="120" required value="${esc(current.name)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div class="sm:col-span-2">
                <label for="profile-photo-url" class="block font-semibold text-stone-500 mb-1">Profile photo</label>
                <input id="profile-photo-url" type="text" maxlength="2048" value="${esc(current.photoUrl && !current.photoUrl.startsWith('data:') ? current.photoUrl : '')}" placeholder="Paste an image URL or upload from your device" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
                <input id="profile-photo-data" type="hidden" value="${esc(current.photoUrl?.startsWith('data:') ? current.photoUrl : '')}" />
                <div class="mt-2 flex items-center gap-3">
                  <img id="profile-photo-preview" alt="Player photo preview" hidden class="h-12 w-12 rounded-full object-cover border border-stone-300 dark:border-stone-700" />
                  <label class="cursor-pointer rounded-lg border border-stone-300 dark:border-stone-700 px-3 py-2 text-xs font-semibold hover:border-gold-500">Upload photo<input id="profile-photo-file" type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" /></label>
                  <button id="profile-photo-clear" type="button" class="text-xs text-stone-500 hover:text-red-500">Remove photo</button>
                </div>
              </div>
              <div>
                <label for="profile-age" class="block font-semibold text-stone-500 mb-1">Age</label>
                <input id="profile-age" type="number" min="1" max="120" step="1" value="${esc(current.age ?? '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="profile-club" class="block font-semibold text-stone-500 mb-1">Club</label>
                <input id="profile-club" type="text" maxlength="120" value="${esc(current.club || '')}" placeholder="Club name" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="profile-skill" class="block font-semibold text-stone-500 mb-1">Skill (1–10)</label>
                <input id="profile-skill" type="number" min="1" max="10" step="1" value="${esc(current.skill ?? '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div class="sm:col-span-2">
                <label for="profile-ranking" class="block font-semibold text-stone-500 mb-1">National / Club Ranking</label>
                <input id="profile-ranking" type="text" maxlength="120" value="${esc(current.ranking || '')}" placeholder="e.g. Club #8 · National B" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
            </div>
            <div class="flex justify-end gap-2 pt-1">
              <button id="player-profile-cancel" type="button" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button type="submit" class="px-4 py-1.5 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Save Profile</button>
            </div>
          </form>
        `);
        bindProfilePhotoControls('profile');
        document.getElementById('player-profile-cancel').addEventListener('click', closeModal);
        document.getElementById('player-profile-form').addEventListener('submit', async event => {
          event.preventDefault();
          const name = document.getElementById('profile-player-name').value.trim();
          const photoUrl = getProfilePhotoValue('profile');
          const ageInput = document.getElementById('profile-age').value;
          const usedCodes = new Set(playerData.profiles.map(item => String(item.playerCode || '')).filter(Boolean));
          const profile = {
            name,
            playerId: current.playerId || createUniqueId(),
            playerCode: current.playerCode || createPlayerCode(usedCodes),
            photoUrl,
            age: ageInput ? Number(ageInput) : null,
            club: document.getElementById('profile-club').value.trim(),
            skill: document.getElementById('profile-skill').value === '' ? null : Number(document.getElementById('profile-skill').value),
            ranking: document.getElementById('profile-ranking').value.trim()
          };
          if (photoUrl && !photoUrl.startsWith('data:')) {
            try {
              const parsedUrl = new URL(photoUrl);
              if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported protocol');
            } catch (_err) {
              showToast('Photo must be an HTTP or HTTPS URL', 'error');
              return;
            }
          }
          if (profile.age !== null && (!Number.isInteger(profile.age) || profile.age < 1 || profile.age > 120)) {
            showToast('Age must be a whole number between 1 and 120', 'error');
            return;
          }
          const submit = event.currentTarget.querySelector('button[type="submit"]');
          submit.disabled = true;
          try {
            const savedProfile = await persistPlayerProfile(profile, editing ? current : null);
            closeModal();
              if (onSaved) {
                onSaved(savedProfile);
              } else {
                state.ui.selectedPlayerName = savedProfile.name;
                state.ui.headToHeadOpponent = '';
                playerData.error = '';
                saveRegistry();
                render();
                showToast('Player profile saved', 'success');
              }
          } catch (err) {
            submit.disabled = false;
            showToast(`Could not save player profile: ${err.message}`, 'error');
          }
        });
      }

      function renderOwnPlayerProfileEditor(profile) {
        const visibility = profile.visibility || {};
        const preferredEvents = new Set(profile.preferredEvents || []);
        const visible = field => visibility[field] !== false;
        const visibilityFields = [
          ['name', 'Full name'], ['nickname', 'Nickname'], ['photoUrl', 'Profile photo'],
          ['age', 'Age'], ['gender', 'Gender'], ['club', 'Club / Academy'], ['ranking', 'Ranking'], ['country', 'Country'],
          ['state', 'State'], ['city', 'City'], ['emergencyContact', 'Emergency contact'],
          ['playingHand', 'Playing hand'], ['preferredEvents', 'Preferred events'], ['email', 'Email'], ['skill', 'Skill']
        ];
        openModal(`
          <form id="player-own-profile-form" class="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
            <div>
              <h3 class="text-base font-bold">My Player Profile</h3>
              <p class="text-xs text-stone-500 dark:text-stone-400 mt-1">These details appear on your player card when their visibility is enabled.</p>
              ${profile.playerCode ? `<p class="mt-2 text-xs font-mono font-bold text-gold-700 dark:text-gold-400">Player code: ${esc(profile.playerCode)}</p>` : ''}
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label for="own-profile-name" class="block font-semibold text-stone-500 mb-1">Full name</label>
                <input id="own-profile-name" type="text" maxlength="120" required value="${esc(profile.name || '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="own-profile-nickname" class="block font-semibold text-stone-500 mb-1">Nickname</label>
                <input id="own-profile-nickname" type="text" maxlength="80" value="${esc(profile.nickname || '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div class="sm:col-span-2">
                <label for="own-profile-photo-url" class="block font-semibold text-stone-500 mb-1">Profile photo</label>
                <input id="own-profile-photo-url" type="text" maxlength="2048" value="${esc(profile.photoUrl && !profile.photoUrl.startsWith('data:') ? profile.photoUrl : '')}" placeholder="Paste an image URL or upload from your device" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
                <input id="own-profile-photo-data" type="hidden" value="${esc(profile.photoUrl?.startsWith('data:') ? profile.photoUrl : '')}" />
                <div class="mt-2 flex items-center gap-3">
                  <img id="own-profile-photo-preview" alt="Profile photo preview" hidden class="h-12 w-12 rounded-full object-cover border border-stone-300 dark:border-stone-700" />
                  <label class="cursor-pointer rounded-lg border border-stone-300 dark:border-stone-700 px-3 py-2 text-xs font-semibold hover:border-gold-500">Upload photo<input id="own-profile-photo-file" type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" /></label>
                  <button id="own-profile-photo-clear" type="button" class="text-xs text-stone-500 hover:text-red-500">Remove photo</button>
                </div>
              </div>
              <div>
                <label for="own-profile-gender" class="block font-semibold text-stone-500 mb-1">Gender</label>
                <input id="own-profile-gender" type="text" maxlength="40" value="${esc(profile.gender || '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="own-profile-club" class="block font-semibold text-stone-500 mb-1">Club / Academy</label>
                <input id="own-profile-club" type="text" maxlength="120" value="${esc(profile.club || '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="own-profile-skill" class="block font-semibold text-stone-500 mb-1">Skill (1–10)</label>
                <input id="own-profile-skill" type="number" min="1" max="10" step="1" value="${esc(profile.skill ?? '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
                <p class="mt-1 text-stone-500">Used when you are added to a tournament; an admin can override it there.</p>
              </div>
              <div>
                <label for="own-profile-country" class="block font-semibold text-stone-500 mb-1">Country</label>
                <input id="own-profile-country" type="text" maxlength="80" value="${esc(profile.country || '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="own-profile-state" class="block font-semibold text-stone-500 mb-1">State</label>
                <input id="own-profile-state" type="text" maxlength="80" value="${esc(profile.state || '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="own-profile-city" class="block font-semibold text-stone-500 mb-1">City</label>
                <input id="own-profile-city" type="text" maxlength="80" value="${esc(profile.city || '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="own-profile-emergency" class="block font-semibold text-stone-500 mb-1">Emergency contact</label>
                <input id="own-profile-emergency" type="text" maxlength="200" value="${esc(profile.emergencyContact || '')}" placeholder="Name and phone number" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
              <div>
                <label for="own-profile-hand" class="block font-semibold text-stone-500 mb-1">Playing hand</label>
                <select id="own-profile-hand" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700">
                  <option value="" ${!profile.playingHand ? 'selected' : ''}>Not specified</option>
                  <option value="Right" ${profile.playingHand === 'Right' ? 'selected' : ''}>Right</option>
                  <option value="Left" ${profile.playingHand === 'Left' ? 'selected' : ''}>Left</option>
                </select>
              </div>
              <div class="sm:col-span-2">
                <span class="block font-semibold text-stone-500 mb-1">Preferred events</span>
                <div class="flex flex-wrap gap-3">
                  ${['Singles', 'Doubles', 'Mixed'].map(event => `
                    <label class="inline-flex items-center gap-1.5">
                      <input type="checkbox" name="own-profile-event" value="${event}" ${preferredEvents.has(event) ? 'checked' : ''} class="rounded border-stone-300 text-gold-500" />
                      <span>${event}</span>
                    </label>
                  `).join('')}
                </div>
              </div>
              <div class="sm:col-span-2">
                <label for="own-profile-email" class="block font-semibold text-stone-500 mb-1">Email address (used to sign in)</label>
                <input id="own-profile-email" type="email" maxlength="254" required value="${esc(profile.email || '')}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700" />
              </div>
            </div>
            <fieldset class="rounded-xl border border-stone-200 dark:border-stone-800 p-3">
              <legend class="px-1 text-xs font-bold">Public profile visibility</legend>
              <p class="text-[11px] text-stone-500 mb-2">You can hide any profile detail. Your name may still appear on historical tournament records.</p>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                ${visibilityFields.map(([field, label]) => `
                  <label class="inline-flex items-center gap-2 text-[11px]">
                    <input type="checkbox" data-own-profile-visibility="${field}" ${visible(field) ? 'checked' : ''} class="rounded border-stone-300 text-gold-500" />
                    <span>Show ${label}</span>
                  </label>
                `).join('')}
              </div>
            </fieldset>
            <div class="flex justify-end gap-2 pt-1">
              <button id="player-own-profile-cancel" type="button" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button type="submit" class="px-4 py-1.5 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Save My Profile</button>
            </div>
          </form>
        `);
      }

      function renderPlayerProfilesView() {
        const analytics = window.PlayerAnalytics.buildAnalytics(playerData.tournaments, playerData.profiles, state.tournamentId);
        const directory = [...analytics.players]
          .filter(player => !isAnonymizedPlayerName(player.name) &&
            (!getSyncApiUrl() || playerData.profiles.some(profile => samePlayerIdentity(profile, { name: player.name }))))
          .sort((a, b) => a.name.localeCompare(b.name));
        const playerSearch = (state.ui.playerSearch || '').toLocaleLowerCase().trim();
        const requestedPlayer = analytics.getPlayer(state.ui.selectedPlayerName);
        const selected = directory.find(player => player.key === requestedPlayer?.key) || directory[0] || null;
        const opponent = directory.find(player =>
          player.key !== selected?.key && player.key === window.PlayerAnalytics.normalizeName(state.ui.headToHeadOpponent)
        ) || directory.find(player => player.key !== selected?.key) || null;
        const headToHead = selected && opponent ? analytics.getHeadToHead(selected.name, opponent.name) : null;
        const prediction = selected && opponent
          ? analytics.getPrediction(selected.name, opponent.name, state.config.pointsToWin, state.config.deuceCap)
          : null;
        const profile = selected?.profile || {};
        const badges = window.PlayerAnalytics.getBadges(selected);
        const matchHistory = selected ? [...selected.results].reverse() : [];
        const tournamentRank = selected ? analytics.getTournamentRank(selected.name, state.tournamentId) : null;
        const seedPosition = selected ? analytics.getSeedPosition(selected.name, state.tournamentId) : null;
        const playerState = playerData.tournaments.find(tournament =>
          String(tournament.id || tournament.tournamentId) === String(state.tournamentId)
        );
        const groups = playerState?.data?.groups || [];
        const playerGroup = selected && groups.find(group =>
          (group.players || []).some(name => window.PlayerAnalytics.normalizeName(analytics.resolveName(name)) === selected.key)
        );
        const partnerships = selected ? analytics.getPartnerships(selected.name) : [];
        const isOwnPlayerProfile = candidate => Boolean(
          state.auth.role === 'player' && playerAccountProfile && samePlayerIdentity(candidate, playerAccountProfile)
        );
        const isOwnProfile = isOwnPlayerProfile(profile);
        const skillLevel = window.PlayerAnalytics.getProfileSkillLevel(profile, isOwnProfile);
        const ownCheckInClosed = state.phase === 'completed';
        const ownRosterParticipant = isOwnProfile ? getOwnPlayerRosterEntry() : null;
        const ownRosterPlayer = ownCheckInClosed ? null : ownRosterParticipant;
        const ownCheckIn = ownRosterPlayer ? state.checkIns?.[ownRosterPlayer.name] : null;
        const publicName = profile.displayName || selected?.name || '';
        const profileDetail = (field, label, value) => {
          if (!value) return '';
          const isVisible = profile.visibility?.[field] !== false;
          if (!isVisible && !isOwnProfile) return '';
          return `<span><b>${label}:</b> ${esc(value)}${!isVisible ? ' <span class="text-stone-400">(hidden publicly)</span>' : ''}</span>`;
        };
        const panelClass = 'rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800';
        const metricCard = (label, value, note) => `
          <div class="p-3.5 rounded-xl bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800">
            <div class="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-stone-500">${label}</div>
            <div class="text-xl font-extrabold mt-1 tabular-nums">${value}</div>
            ${note ? `<div class="text-[10px] text-stone-500 mt-1">${esc(note)}</div>` : ''}
          </div>
        `;

        return `
          <section class="space-y-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 class="text-xl sm:text-2xl font-extrabold tracking-tight">Players &amp; Performance</h1>
                <p class="text-sm text-stone-500 dark:text-stone-400 mt-1">Stats recalculate from completed scores across saved tournaments; pending matches are excluded.</p>
              </div>
              <div class="flex gap-2">
                <button id="player-refresh-btn" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold hover:bg-stone-100 dark:hover:bg-stone-800">Refresh Stats</button>
                ${state.auth.role === 'admin' ? '<button id="player-bulk-delete-btn" class="px-3 py-2 rounded-lg border border-red-300 dark:border-red-900/60 text-xs font-semibold text-red-600 dark:text-red-400">Delete Players</button><button id="player-invites-btn" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold">Player Invites</button><button id="player-add-profile-btn" class="px-3 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">+ Add Profile</button>' : ''}
              </div>
            </div>
            ${playerData.error ? `<div role="status" class="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300">${esc(playerData.error)}. Previously loaded results may be out of date.</div>` : ''}
            ${playerData.loading ? `<div class="p-3 rounded-lg ${panelClass} text-xs text-stone-500">Loading player history…</div>` : ''}
            ${directory.length === 0 && !playerData.loading ? renderEmptyState('No players found', 'Add players to a tournament roster or create a player profile as an admin.') : `
              <div class="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-5 items-start">
                <aside class="${panelClass} p-4 space-y-3">
                  <div class="flex items-center justify-between">
                    <h2 class="font-bold text-sm">Player Directory</h2>
                    <span class="text-[11px] text-stone-500">${directory.length} players</span>
                  </div>
                  <input id="player-directory-search" type="search" value="${esc(state.ui.playerSearch || '')}" placeholder="Search players…" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs" />
                  <div class="max-h-[28rem] overflow-y-auto space-y-1">
                    ${directory.map(player => `
                      <button data-player-select="${esc(player.name)}" data-player-directory-name="${esc((player.profile.displayName || player.name).toLocaleLowerCase())}" class="w-full flex items-center gap-2.5 text-left p-2 rounded-lg transition ${playerSearch && !(player.profile.displayName || player.name).toLocaleLowerCase().includes(playerSearch) ? 'hidden' : ''} ${player.key === selected?.key ? 'bg-gold-500/15 border border-gold-500/30' : 'hover:bg-cream-100 dark:hover:bg-stone-800 border border-transparent'}">
                        ${getPlayerAvatar(player.name, player.profile, 'w-9 h-9')}
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-xs font-semibold">${esc(player.profile.displayName || player.name)}</span>
                          <span class="block text-[10px] text-stone-500">${player.wins}W · ${player.losses}L · ${window.PlayerAnalytics.getProfileSkillLevel(player.profile, isOwnPlayerProfile(player.profile))?.label || 'Skill unavailable'}</span>
                        </span>
                      </button>
                    `).join('')}
                  </div>
                </aside>

                ${selected ? `
                  <div class="space-y-5 min-w-0">
                    <article class="${panelClass} p-4 sm:p-5 flex flex-wrap items-center gap-4">
                      ${getPlayerAvatar(selected.name, profile, 'w-20 h-20')}
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <h2 class="text-xl font-extrabold">${esc(publicName)}</h2>
                          <span class="px-2 py-0.5 rounded-full bg-gold-500/15 text-gold-700 dark:text-gold-400 text-[11px] font-bold">${skillLevel?.label || 'Skill unavailable'}</span>
                        </div>
                        <div class="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-stone-500">
                          ${profileDetail('age', 'Age', profile.age)}
                          ${profileDetail('club', 'Club / Academy', profile.club)}
                          ${profileDetail('ranking', 'Ranking', profile.ranking)}
                          ${profileDetail('skill', 'Skill', profile.skill ? `${profile.skill}/10` : '')}
                        </div>
                        <div class="text-xs font-semibold mt-2">${selected.titlesWon} title${selected.titlesWon === 1 ? '' : 's'} · ${selected.wins}W–${selected.losses}L</div>
                        ${profile.playerCode ? `<div class="mt-1 text-[10px] font-mono text-stone-500">Player code: ${esc(profile.playerCode)}</div>` : ''}
                        <div class="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-stone-500">
                          ${profileDetail('nickname', 'Nickname', profile.nickname)}
                          ${profileDetail('gender', 'Gender', profile.gender)}
                          ${profileDetail('country', 'Country', profile.country)}
                          ${profileDetail('state', 'State', profile.state)}
                          ${profileDetail('city', 'City', profile.city)}
                          ${profileDetail('emergencyContact', 'Emergency contact', profile.emergencyContact)}
                          ${profileDetail('playingHand', 'Playing hand', profile.playingHand)}
                          ${profileDetail('preferredEvents', 'Preferred events', (profile.preferredEvents || []).join(', '))}
                          ${profileDetail('email', 'Email', profile.email)}
                        </div>
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <button id="player-share-btn" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold">Share Card</button>
                        ${state.auth.role === 'admin' ? `<button id="player-edit-profile-btn" data-player-edit-name="${esc(selected.name)}" class="px-3 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Edit Profile</button>` : ''}
                        ${state.auth.role === 'admin' ? `<button id="player-reset-password-btn" data-player-account-name="${esc(profile.name || selected.name)}" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold">Reset Password</button><button id="player-delete-account-btn" data-player-account-name="${esc(profile.name || selected.name)}" class="px-3 py-2 rounded-lg border border-red-300 dark:border-red-900/60 text-xs font-semibold text-red-600 dark:text-red-400">Delete Player Login</button>` : ''}
                        ${state.auth.role === 'admin' ? `<button id="player-delete-profile-btn" data-player-delete-name="${esc(selected.name)}" class="px-3 py-2 rounded-lg border border-red-300 dark:border-red-900/60 text-xs font-semibold text-red-600 dark:text-red-400">Delete Profile &amp; History</button>` : ''}
                        ${isOwnProfile ? '<button id="player-edit-own-profile-btn" class="px-3 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Edit My Profile</button>' : ''}
                        ${isOwnProfile ? '<button id="player-change-password-btn" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold">Change Password</button><button id="player-delete-own-account-btn" class="px-3 py-2 rounded-lg border border-red-300 dark:border-red-900/60 text-xs font-semibold text-red-600 dark:text-red-400">Delete My Account</button>' : ''}
                        ${isOwnProfile && ownRosterPlayer ? `<button id="player-self-checkin-btn" ${ownCheckIn?.checkedIn ? 'disabled' : ''} class="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold ${ownCheckIn?.checkedIn ? 'opacity-70 cursor-not-allowed' : 'hover:bg-emerald-500'}">${ownCheckIn?.checkedIn ? `Checked In${ownCheckIn.time ? ` · ${esc(ownCheckIn.time)}` : ''}` : 'Check In'}</button>` : ''}
                      </div>
                      ${isOwnProfile && !ownRosterParticipant && !ownCheckInClosed ? '<p class="w-full text-xs text-stone-500">You are not on this tournament roster, so check-in is unavailable.</p>' : ''}
                      ${isOwnProfile && ownRosterParticipant && ownCheckInClosed ? '<p class="w-full text-xs text-stone-500">Check-in is closed for this completed tournament.</p>' : ''}
                    </article>

                    <section class="grid grid-cols-2 xl:grid-cols-4 gap-3">
                      ${metricCard('Matches Played', selected.matchesPlayed)}
                      ${metricCard('Matches Won', selected.wins)}
                      ${metricCard('Matches Lost', selected.losses)}
                      ${metricCard('Win Percentage', `${selected.winPercentage.toFixed(1)}%`)}
                    </section>

                    <section class="${panelClass} p-4 sm:p-5 space-y-3">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 class="font-bold text-sm">Tournament Performance</h3>
                          <p class="text-[11px] text-stone-500 mt-1">Ranking points use the tournament’s configured win and point-margin rules.</p>
                        </div>
                      </div>
                      <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                        ${metricCard('Tournament Rank', tournamentRank ? `#${tournamentRank}` : '—', state.config.name)}
                        ${metricCard('Seed Position', seedPosition ? `#${seedPosition.position}` : '—', seedPosition ? `${playerGroup?.name || 'QR1 group'} · ${seedPosition.total} players` : 'Available after QR1')}
                        ${metricCard('Ranking Points Earned', Math.round(selected.rankingPointsEarned))}
                        ${metricCard('Titles Won', selected.titlesWon)}
                        ${metricCard('Finals Reached', selected.finalsReached)}
                        ${metricCard('Longest Win Streak', selected.longestWinningStreak)}
                        ${metricCard('National / Club Rank', profile.visibility?.ranking === false && !isOwnProfile ? '—' : esc(profile.ranking || '—'))}
                        ${metricCard('Avg. Point Difference', selected.averagePointDifference.toFixed(1))}
                      </div>
                    </section>

                    <section class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div class="${panelClass} p-4 sm:p-5 space-y-3">
                        <div class="flex items-center justify-between">
                          <h3 class="font-bold text-sm">Recent Form</h3>
                          <span class="text-sm font-extrabold text-gold-600 dark:text-gold-400">${Math.round(selected.formRating)}%</span>
                        </div>
                        <div class="flex items-center gap-1.5">
                          ${(selected.form === '—' ? [] : selected.form.split('-')).map(result => `<span class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-extrabold ${result === 'W' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/15 text-red-600 dark:text-red-400'}">${result}</span>`).join('') || '<span class="text-xs text-stone-500">No recorded matches</span>'}
                        </div>
                        <p class="text-xs text-stone-500">Last 5 matches · Form score ${Math.round(selected.formRating)}%</p>
                      </div>
                      <div class="${panelClass} p-4 sm:p-5 space-y-3">
                        <div class="flex items-center justify-between gap-2">
                          <div>
                            <h3 class="font-bold text-sm">Skill Level</h3>
                            <p class="text-[11px] text-stone-500 mt-1">Based on the player's profile skill, not match results or tournament overrides.</p>
                          </div>
                          <div class="text-right">
                            <div class="text-lg font-extrabold">${skillLevel?.label || 'Not available'}</div>
                            ${skillLevel ? `<div class="text-xs text-stone-500">${skillLevel.skill}/10</div>` : ''}
                          </div>
                        </div>
                        ${skillLevel ? `<div class="h-2 rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden"><div class="h-full bg-gold-500 rounded-full" style="width:${skillLevel.skill * 10}%"></div></div>` : '<p class="text-xs text-stone-500">A visible profile skill is required to show a level.</p>'}
                        <div class="flex flex-wrap justify-between gap-2 text-[10px] text-stone-500"><span>Beginner 1–5</span><span>Intermediate 6–7</span><span>Advanced 8–10</span></div>
                      </div>
                    </section>

                    <section class="${panelClass} p-4 sm:p-5 space-y-3">
                      <div>
                        <h3 class="font-bold text-sm">Completed Match Scores</h3>
                        <p class="text-[11px] text-stone-500 mt-1">Every saved score for this player, shown from their side of the match.</p>
                      </div>
                      ${matchHistory.length ? `
                        <div class="max-h-96 overflow-y-auto divide-y divide-stone-200 dark:divide-stone-800">
                          ${matchHistory.map(({ record, won, opponentSide }) => {
                            const onSide1 = record.side1.some(name => window.PlayerAnalytics.normalizeName(name) === selected.key);
                            const pointsFor = onSide1 ? record.points1 : record.points2;
                            const pointsAgainst = onSide1 ? record.points2 : record.points1;
                            const scoreText = record.gameScores?.length > 1
                              ? record.gameScores.map(game => `${onSide1 ? game.s1 : game.s2}–${onSide1 ? game.s2 : game.s1}`).join(' · ')
                              : `${pointsFor}–${pointsAgainst}`;
                            const stage = { qr1: 'Qualifier 1', qr2: 'Qualifier 2', semis: 'Semi-final', finals: 'Final' }[record.stage] || record.stage;
                            return `
                              <article data-player-match-result="${esc(record.id)}" class="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs">
                                <div class="min-w-0">
                                  <div class="font-semibold">${esc(record.tournamentName)} · ${esc(stage)}${record.groupId ? ` · ${esc(record.groupId)}` : ''}</div>
                                  <div class="mt-0.5 text-stone-500">vs ${esc(opponentSide.join(' & '))}${record.tournamentDate ? ` · ${esc(record.tournamentDate)}` : ''}</div>
                                </div>
                                <div class="flex items-center gap-2 shrink-0">
                                  <span class="${won ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'} font-bold">${won ? 'Win' : 'Loss'}</span>
                                  <span class="font-extrabold tabular-nums">${scoreText}</span>
                                </div>
                              </article>
                            `;
                          }).join('')}
                        </div>
                      ` : '<p class="rounded-lg bg-cream-50 dark:bg-[#111214] p-3 text-xs text-stone-500">No completed match scores yet.</p>'}
                    </section>

                    <section class="${panelClass} p-4 sm:p-5 space-y-4">
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 class="font-bold text-sm">Head-to-Head &amp; Match Forecast</h3>
                          <p class="text-[11px] text-stone-500 mt-1">Includes singles and opposing doubles matchups.</p>
                        </div>
                        <select id="head-to-head-opponent" class="max-w-48 px-2.5 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs" ${directory.length < 2 ? 'disabled' : ''}>
                          ${directory.filter(player => player.key !== selected.key).map(player => `<option value="${esc(player.name)}" ${player.key === opponent?.key ? 'selected' : ''}>${esc(player.profile.displayName || player.name)}</option>`).join('')}
                        </select>
                      </div>
                      ${opponent && headToHead ? `
                        <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                          ${metricCard('Meetings', headToHead.totalMeetings)}
                          ${metricCard('Wins / Losses', `${headToHead.wins} / ${headToHead.losses}`)}
                          ${metricCard('Win % vs Opponent', `${headToHead.winPercentage.toFixed(1)}%`)}
                          ${metricCard('Avg. Score Diff.', headToHead.averageScoreDifference.toFixed(1))}
                          ${metricCard('Last Result', headToHead.lastMatchResult, headToHead.lastTournament)}
                          ${metricCard('Win Streak', headToHead.currentWinStreak)}
                        </div>
                        <div class="rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 p-3 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div class="text-xs font-semibold">Estimated next-match outlook</div>
                            <div class="text-[10px] text-stone-500 mt-1">Heuristic from past match performance and recorded scores; not betting or official ranking advice.</div>
                          </div>
                          ${prediction ? `<div class="text-right text-xs tabular-nums"><div><b>${prediction.winProbabilityA.toFixed(0)}%</b> win chance · expected score <b>${prediction.expectedScoreA}–${prediction.expectedScoreB}</b></div><div class="text-[10px] text-stone-500 mt-1">Upset probability ${prediction.upsetProbability.toFixed(0)}% · sample confidence ${prediction.confidence.toFixed(0)}%</div></div>` : '<span class="text-xs text-stone-500">Select another player</span>'}
                        </div>
                      ` : '<p class="text-xs text-stone-500">Select another player to view comparison stats.</p>'}
                    </section>

                    <section class="${panelClass} p-4 sm:p-5 space-y-3">
                      <div>
                        <h3 class="font-bold text-sm">Doubles Partnerships</h3>
                        <p class="text-[11px] text-stone-500 mt-1">Chemistry is wins together divided by completed matches together.</p>
                      </div>
                      ${partnerships.length ? `
                        <div class="overflow-x-auto">
                          <table class="w-full min-w-[600px] text-xs text-left">
                            <thead class="text-[10px] uppercase text-stone-500 border-b border-stone-200 dark:border-stone-800"><tr><th class="py-2 pr-3">Partner</th><th class="px-2 py-2 text-center">Played</th><th class="px-2 py-2 text-center">Win Rate / Chemistry</th><th class="px-2 py-2 text-center">Titles Together</th><th class="px-2 py-2 text-center">Avg Points</th><th class="pl-2 py-2 text-right">Best Finish</th></tr></thead>
                            <tbody class="divide-y divide-stone-100 dark:divide-stone-800/70">
                              ${partnerships.map(partnership => `<tr><td class="py-2.5 pr-3 font-semibold">${esc(partnership.partnerName)}</td><td class="px-2 py-2.5 text-center">${partnership.matchesPlayedTogether}</td><td class="px-2 py-2.5 text-center">${partnership.winRateTogether.toFixed(0)}%</td><td class="px-2 py-2.5 text-center">${partnership.titlesTogether}</td><td class="px-2 py-2.5 text-center">${partnership.averagePointsPerMatch.toFixed(1)}</td><td class="pl-2 py-2.5 text-right">${esc(partnership.bestTournamentFinish)}</td></tr>`).join('')}
                            </tbody>
                          </table>
                        </div>
                      ` : '<p class="text-xs text-stone-500">Doubles partnership stats appear after completed doubles matches.</p>'}
                    </section>

                    <section class="${panelClass} p-4 sm:p-5 space-y-3">
                      <h3 class="font-bold text-sm">Career Badges</h3>
                      <div class="flex flex-wrap gap-2">
                        ${badges.map(badge => `<span class="px-2.5 py-1.5 rounded-full border border-gold-500/30 bg-gold-500/10 text-xs font-semibold">${badge.icon} ${esc(badge.label)}</span>`).join('')}
                        <span title="Awarding this badge is deferred until tournaments record three event categories." class="px-2.5 py-1.5 rounded-full border border-dashed border-stone-300 dark:border-stone-700 text-xs text-stone-500">👑 Triple Crown · 3-event tracking required</span>
                        ${badges.length === 0 ? '<span class="text-xs text-stone-500">Milestone badges unlock as results are recorded.</span>' : ''}
                      </div>
                    </section>
                  </div>
                ` : ''}
              </div>
            `}
          </section>
        `;
      }

      function renderPlayerCheckInScreen() {
        if (state.auth.role !== 'admin') {
          const players = getAllImportedPlayers();
          const checkedInCount = players.filter(p => state.checkIns?.[p.name]?.checkedIn).length;
          const message = state.auth.role === 'player'
            ? 'Use My Player Card to check in yourself if you are on this tournament roster.'
            : 'Guest access is view-only. A player must sign in to check in themselves.';
          return `
            <div class="min-h-screen flex flex-col items-center justify-center p-4">
              <div class="absolute top-4 right-4">${renderThemeSwitcher()}</div>
              <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 shadow-xl p-6 space-y-5">
                <div class="flex items-center justify-between gap-2">
                  <div>
                    <h1 class="text-lg font-bold tracking-tight">${esc(state.config.name)}</h1>
                    <p class="text-xs text-stone-500">${message}</p>
                  </div>
                  <button id="exit-player-checkin-btn" class="px-2.5 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Back</button>
                </div>
                <div class="rounded-xl bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 p-4">
                  <div class="text-xs text-stone-500">Players checked in</div>
                  <div class="mt-1 text-2xl font-extrabold tabular-nums">${checkedInCount} / ${players.length}</div>
                </div>
              </div>
            </div>
          `;
        }
        const players = getAllImportedPlayers();
        const checkedInCount = players.filter(p => state.checkIns?.[p.name]?.checkedIn).length;
        return `
          <div class="min-h-screen flex flex-col items-center justify-center p-4">
            <div class="absolute top-4 right-4">${renderThemeSwitcher()}</div>
            <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 shadow-xl p-6 sm:p-8 space-y-5">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <h1 class="text-lg font-bold tracking-tight">${esc(state.config.name)}</h1>
                  <p class="text-xs text-stone-500 dark:text-stone-400">Player QR Check-In · ${checkedInCount}/${players.length} signed in</p>
                </div>
                <button id="exit-player-checkin-btn" class="px-2.5 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium hover:bg-cream-100 dark:hover:bg-stone-800">Back</button>
              </div>

              <div id="checkin-confirm-banner" class="hidden rounded-xl bg-emerald-500/15 border border-emerald-500/30 p-3 text-xs font-semibold text-emerald-700 dark:text-emerald-300"></div>

              <div class="space-y-2">
                <label class="block text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">Find Your Name</label>
                <input id="player-checkin-search" type="text" placeholder="Search imported player name..." class="w-full px-3.5 py-2.5 rounded-xl bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm focus:outline-none focus:ring-2 focus:ring-gold-500" />
              </div>

              <div id="player-checkin-list" class="max-h-64 overflow-y-auto divide-y divide-stone-100 dark:divide-stone-800 border border-stone-200 dark:border-stone-800 rounded-xl">
                ${players.map(p => {
                  const isSignedIn = Boolean(state.checkIns?.[p.name]?.checkedIn);
                  const time = state.checkIns?.[p.name]?.time || '';
                  return `
                    <div class="px-3.5 py-2.5 flex items-center justify-between gap-2" data-checkin-item="${esc(p.name.toLowerCase())}">
                      <div class="min-w-0">
                        <div class="text-sm font-semibold truncate">${esc(p.name)}</div>
                        <div class="text-[11px] text-stone-500">${esc(p.group)}${p.isLeader ? ' · ★ Leader' : ''}</div>
                      </div>
                      ${isSignedIn
                        ? `<span class="px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-xs font-semibold whitespace-nowrap">✓ Signed In (${esc(time)})</span>`
                        : `<button data-player-self-checkin="${esc(p.name)}" class="px-3 py-1.5 rounded-lg bg-gold-500 hover:bg-gold-400 text-stone-950 text-xs font-bold whitespace-nowrap transition">Sign In</button>`}
                    </div>
                  `;
                }).join('')}
              </div>

            </div>
          </div>
        `;
      }

      function renderCheckInView() {
        const isAdmin = state.auth.role === 'admin';
        const ownRosterPlayer = state.auth.role === 'player' ? getOwnPlayerRosterEntry() : null;
        const ownCheckIn = ownRosterPlayer ? state.checkIns?.[ownRosterPlayer.name] : null;
        const players = getAllImportedPlayers();
        const signedInCount = players.filter(p => state.checkIns?.[p.name]?.checkedIn).length;
        const pendingCount = players.length - signedInCount;
        const pct = players.length > 0 ? Math.round((signedInCount / players.length) * 100) : 0;
        const filter = state.ui.checkInFilter || 'ALL';
        const search = (state.ui.checkInSearch || '').toLowerCase().trim();
        const groupFilter = state.ui.checkInGroupFilter ?? 'ALL';
        const skillMin = state.ui.checkInSkillMin !== '' && state.ui.checkInSkillMin !== undefined ? Number(state.ui.checkInSkillMin) : 1;
        const skillMax = state.ui.checkInSkillMax !== '' && state.ui.checkInSkillMax !== undefined ? Number(state.ui.checkInSkillMax) : 10;

        const filtered = players.filter(p => {
          const isSignedIn = Boolean(state.checkIns?.[p.name]?.checkedIn);
          const skill = getPlayerSkill(p.name);
          if (filter === 'SIGNED_IN' && !isSignedIn) return false;
          if (filter === 'PENDING' && isSignedIn) return false;
          if (groupFilter !== 'ALL' && String(p.groupIndex) !== String(groupFilter)) return false;
          if (skill < skillMin || skill > skillMax) return false;
          if (search && !p.name.toLowerCase().includes(search) && !p.group.toLowerCase().includes(search)) return false;
          return true;
        });

        return `
          <div class="space-y-6">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 class="text-base font-bold">Imported vs. Signed-In Players</h2>
                <p class="text-xs text-stone-500 dark:text-stone-400">Track attendance from your imported roster and QR check-ins</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                ${isAdmin ? '<button id="ci-import-btn" class="px-3.5 py-2 rounded-lg border border-stone-300 dark:border-stone-700 hover:bg-cream-100 dark:hover:bg-stone-800 text-xs font-semibold transition">Import Players</button>' : ''}
                ${ownRosterPlayer ? `<button id="player-self-checkin-btn" ${ownCheckIn?.checkedIn ? 'disabled' : ''} class="px-3.5 py-2 rounded-lg bg-emerald-600 text-white text-xs font-bold disabled:opacity-70">${ownCheckIn?.checkedIn ? 'Checked In' : 'Check In'}</button>` : ''}
                <button id="show-qr-modal-btn" class="px-3.5 py-2 rounded-lg bg-gold-500 hover:bg-gold-400 text-stone-950 text-xs font-bold transition">Show Check-In QR Code</button>
                <button id="launch-kiosk-btn" class="px-3.5 py-2 rounded-lg border border-stone-300 dark:border-stone-700 hover:bg-cream-100 dark:hover:bg-stone-800 text-xs font-semibold transition">Open Player Sign-In</button>
              </div>
            </div>

            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4">
                <div class="text-xs font-semibold uppercase tracking-wider text-stone-500">Imported Players</div>
                <div class="text-2xl font-extrabold mt-1 tabular-nums">${players.length}</div>
              </div>
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4">
                <div class="text-xs font-semibold uppercase tracking-wider text-stone-500">Signed In</div>
                <div class="text-2xl font-extrabold mt-1 text-emerald-600 dark:text-emerald-400 tabular-nums">${signedInCount}</div>
              </div>
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4">
                <div class="text-xs font-semibold uppercase tracking-wider text-stone-500">Not Signed In</div>
                <div class="text-2xl font-extrabold mt-1 text-amber-600 dark:text-amber-400 tabular-nums">${pendingCount}</div>
              </div>
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4">
                <div class="text-xs font-semibold uppercase tracking-wider text-stone-500">Attendance</div>
                <div class="text-2xl font-extrabold mt-1 text-gold-600 dark:text-gold-400 tabular-nums">${pct}%</div>
              </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-1.5">
                <button data-checkin-filter="ALL" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${filter === 'ALL' ? 'bg-gold-500 text-stone-950' : 'bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800'}">All (${players.length})</button>
                <button data-checkin-filter="SIGNED_IN" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${filter === 'SIGNED_IN' ? 'bg-emerald-600 text-white' : 'bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800'}">Signed In (${signedInCount})</button>
                <button data-checkin-filter="PENDING" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${filter === 'PENDING' ? 'bg-amber-500 text-stone-950' : 'bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800'}">Not Signed In (${pendingCount})</button>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <input id="checkin-table-search" type="text" value="${esc(state.ui.checkInSearch || '')}" placeholder="Filter by name..." class="w-40 sm:w-48 px-3 py-1.5 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs" />
                <select id="checkin-group-filter" class="px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs">
                  <option value="ALL" ${groupFilter === 'ALL' ? 'selected' : ''}>All Groups</option>
                  ${state.groups.map((g, gi) => `<option value="${gi}" ${String(groupFilter) === String(gi) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
                </select>
                <div class="inline-flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
                  <span>Skill:</span>
                  <input id="checkin-skill-min" type="number" min="1" max="10" placeholder="1" value="${esc(state.ui.checkInSkillMin ?? '')}" class="w-12 px-1.5 py-1.5 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs text-center tabular-nums" />
                  <span>–</span>
                  <input id="checkin-skill-max" type="number" min="1" max="10" placeholder="10" value="${esc(state.ui.checkInSkillMax ?? '')}" class="w-12 px-1.5 py-1.5 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs text-center tabular-nums" />
                </div>
                ${(filter !== 'ALL' || search || groupFilter !== 'ALL' || state.ui.checkInSkillMin || state.ui.checkInSkillMax)
                  ? '<button id="checkin-clear-filters" class="px-2.5 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium hover:bg-stone-100 dark:hover:bg-stone-800">Clear</button>'
                  : ''}
              </div>
            </div>

            ${isAdmin ? `
              <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-3.5 flex flex-wrap items-center gap-2">
                <span class="text-xs font-bold text-stone-500 dark:text-stone-400 mr-1">Add Player:</span>
                <input id="ci-add-name" type="text" placeholder="Player name" class="flex-1 min-w-[150px] px-3 py-1.5 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs" />
                <select id="ci-add-group" class="px-2.5 py-1.5 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs">
                  ${state.groups.map((g, gi) => `<option value="${gi}">${esc(g.name)}</option>`).join('')}
                </select>
                <input id="ci-add-skill" type="number" min="1" max="10" step="1" placeholder="Skill" title="Optional skill override (1-10); otherwise use profile skill" class="w-14 px-2 py-1.5 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs text-center font-semibold tabular-nums" />
                <label class="inline-flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-300 px-1">
                  <input id="ci-add-signedin" type="checkbox" checked class="rounded border-stone-300 text-gold-500" />
                  <span>Signed In</span>
                </label>
                <button id="ci-add-btn" class="px-3.5 py-1.5 rounded-lg bg-gold-500 hover:bg-gold-400 text-stone-950 text-xs font-bold transition">+ Add</button>
              </div>
            ` : ''}

            <div class="rounded-xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 overflow-hidden">
              <div class="overflow-x-auto">
                <table class="w-full text-xs sm:text-sm text-left">
                  <thead class="bg-cream-100/70 dark:bg-stone-800/60 text-stone-500 dark:text-stone-400 text-[11px] uppercase">
                    <tr>
                      <th class="px-4 py-2.5">Player</th>
                      <th class="px-4 py-2.5">Group</th>
                      <th class="px-4 py-2.5 text-center">Skill</th>
                      <th class="px-4 py-2.5">Status</th>
                      <th class="px-4 py-2.5">Sign-In Time</th>
                      ${isAdmin ? '<th class="px-4 py-2.5 text-right">Action</th>' : ''}
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-stone-100 dark:divide-stone-800/70">
                    ${filtered.length === 0 ? `<tr><td colspan="${isAdmin ? 5 : 4}" class="px-4 py-6 text-center text-xs text-stone-500">No players match this filter.</td></tr>` : filtered.map(p => {
                      const info = state.checkIns?.[p.name];
                      const isSignedIn = Boolean(info?.checkedIn);
                      return `
                        <tr>
                          <td class="px-4 py-2">
                            ${isAdmin ? `
                              <div class="flex items-center gap-1.5">
                                <button data-ci-leader="${p.groupIndex}:${p.playerIndex}" title="Toggle group leader" class="w-6 h-6 rounded flex items-center justify-center text-xs ${p.isLeader ? 'bg-gold-500/20 text-gold-500' : 'text-stone-400 hover:text-gold-500'}">★</button>
                                <input data-ci-edit-name="${p.groupIndex}:${p.playerIndex}" type="text" value="${esc(p.name)}" class="w-32 sm:w-40 px-2 py-1 rounded-md bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 text-xs font-semibold" />
                              </div>
                            ` : `<span class="font-semibold">${esc(p.name)} ${p.isLeader ? '<span class="text-gold-500 text-xs">★</span>' : ''}</span>`}
                          </td>
                          <td class="px-4 py-2">
                            ${isAdmin ? `
                              <select data-ci-move-group="${p.groupIndex}:${p.playerIndex}" class="px-2 py-1 rounded-md bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 text-xs">
                                ${state.groups.map((og, ogi) => `<option value="${ogi}" ${ogi === p.groupIndex ? 'selected' : ''}>${esc(og.name)}</option>`).join('')}
                              </select>
                            ` : `<span class="text-stone-500 dark:text-stone-400">${esc(p.group)}</span>`}
                          </td>
                          <td class="px-4 py-2 text-center">
                            ${isAdmin ? `
                              <input data-ci-edit-skill="${esc(p.name)}" type="number" min="1" max="10" value="${getPlayerSkill(p.name)}" class="w-12 px-1.5 py-1 rounded-md bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 text-xs text-center font-semibold tabular-nums" />
                            ` : `<span class="font-semibold tabular-nums">${getPlayerSkill(p.name)}/10</span>`}
                          </td>
                          <td class="px-4 py-2">
                            ${isSignedIn
                              ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Signed In</span>'
                              : '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400">Not Signed In</span>'}
                          </td>
                          <td class="px-4 py-2 text-xs text-stone-500 tabular-nums">
                            ${isAdmin && isSignedIn
                              ? `<input data-ci-edit-time="${esc(p.name)}" type="text" value="${esc(info.time || '')}" class="w-20 px-2 py-1 rounded-md bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 text-xs tabular-nums" />`
                              : (isSignedIn ? esc(info.time || '—') : '—')}
                          </td>
                          ${isAdmin ? `
                            <td class="px-4 py-2 text-right whitespace-nowrap">
                              <div class="inline-flex items-center gap-1.5">
                                <button data-toggle-checkin="${esc(p.name)}" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition ${isSignedIn ? 'border border-stone-300 dark:border-stone-700 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}">
                                  ${isSignedIn ? 'Undo' : 'Check In'}
                                </button>
                                <button data-ci-remove="${p.groupIndex}:${p.playerIndex}" title="Remove player" class="w-7 h-7 rounded-lg text-stone-400 hover:text-red-500 hover:bg-red-500/10 text-xs">✕</button>
                              </div>
                            </td>
                          ` : ''}
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        `;
      }

      function renderBracketOverlay(asPage) {
        const poolBracket = (poolKey, accent) => {
          const sf = state.semis[poolKey] || [];
          const fn = state.finals[poolKey];
          return `
            <div class="rounded-xl bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800 p-5 space-y-4">
              <h3 class="font-bold text-base ${accent}">Group ${poolKey} Bracket</h3>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                <div class="space-y-3">
                  <div class="text-xs font-semibold uppercase text-stone-500">Semi-Finals</div>
                  ${[0, 1].map(i => {
                    const m = sf[i];
                    return `
                      <div class="p-3 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 text-xs space-y-1">
                        <div class="text-stone-400 font-medium">Semi-Final ${i + 1}</div>
                        ${m ? `<div class="font-semibold">${esc(m.t1)} ${m.completed ? `(${m.s1})` : ''}</div><div class="font-semibold">${esc(m.t2)} ${m.completed ? `(${m.s2})` : ''}</div>` : `<div class="italic text-stone-400">Awaiting QR2</div>`}
                      </div>
                    `;
                  }).join('')}
                </div>
                <div class="space-y-2">
                  <div class="text-xs font-semibold uppercase text-stone-500">Final</div>
                  <div class="p-3 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 text-xs space-y-1">
                    <div class="text-stone-400 font-medium">Group ${poolKey} Final</div>
                    ${fn ? `<div class="font-semibold">${esc(fn.t1)}</div><div class="font-semibold">${esc(fn.t2)}</div>` : `<div class="italic text-stone-400">Awaiting Semis</div>`}
                  </div>
                </div>
                <div class="space-y-2">
                  <div class="text-xs font-semibold uppercase text-stone-500">Winner</div>
                  <div class="p-4 rounded-lg bg-gold-500/10 border border-gold-500/30 text-sm font-bold text-center">
                    ${fn?.winner ? esc(fn.winner) : 'TBD'}
                  </div>
                </div>
              </div>
            </div>
          `;
        };

        return `
          <div class="${asPage ? 'space-y-4' : 'fixed inset-0 z-40 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto'}">
            <div class="w-full max-w-5xl ${asPage ? 'mx-auto rounded-xl' : 'rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto'} bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-6 space-y-5">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <h2 class="text-lg font-bold">Tournament Bracket</h2>
                ${asPage
                  ? `<a href="${esc(getPageUrl('finals'))}" data-tab="finals" class="inline-flex min-h-11 items-center rounded-lg bg-gold-500 px-4 py-2 text-sm font-bold text-stone-950">View Finals</a>`
                  : '<button id="close-bracket-btn" class="px-3 py-1.5 rounded-lg bg-stone-200 dark:bg-stone-800 text-xs font-semibold">Close</button>'}
              </div>
              ${getActiveQR2PoolKeys().map(k => poolBracket(k, getPoolAccent(k))).join('')}
            </div>
          </div>
        `;
      }

      function renderEmptyState(title, desc) {
        return `
          <div class="rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-10 text-center max-w-lg mx-auto my-8 space-y-2">
            <h2 class="text-base font-bold">${esc(title)}</h2>
            <p class="text-sm text-stone-500 dark:text-stone-400">${esc(desc)}</p>
          </div>
        `;
      }

      function bindThemeButtons() {
        document.querySelectorAll('[data-theme-btn]').forEach(btn => {
          btn.addEventListener('click', () => {
            applyTheme(btn.getAttribute('data-theme-btn'));
            render();
          });
        });
      }

      function bindReadOnlyPlayerCheckInEvents() {
        bindThemeButtons();
        document.getElementById('exit-player-checkin-btn')?.addEventListener('click', () => {
          state.ui.playerCheckInMode = false;
          if (window.location.hash === '#checkin') {
            try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
          }
          render();
        });
      }

      function bindPlayerCheckInEvents() {
        bindThemeButtons();
        document.getElementById('exit-player-checkin-btn')?.addEventListener('click', () => {
          state.ui.playerCheckInMode = false;
          if (window.location.hash === '#checkin') {
            try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
          }
          render();
        });
        document.getElementById('player-checkin-search')?.addEventListener('input', (e) => {
          const q = e.target.value.toLowerCase().trim();
          document.querySelectorAll('[data-checkin-item]').forEach(row => {
            const name = row.getAttribute('data-checkin-item') || '';
            row.classList.toggle('hidden', Boolean(q && !name.includes(q)));
          });
        });
        document.querySelectorAll('[data-player-self-checkin]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const name = btn.getAttribute('data-player-self-checkin');
            try {
              await syncCheckInToServer(name, true, 'qr');
              render();
              const banner = document.getElementById('checkin-confirm-banner');
              if (banner) {
                banner.textContent = `✓ ${name} is signed in!`;
                banner.classList.remove('hidden');
              }
              showToast(`${name} signed in`, 'success');
            } catch (err) {
              showToast(`Check-in for ${name} could not be confirmed: ${err.message}. Refresh before retrying.`, 'error');
            }
          });
        });
      }

      function bindLoginEvents() {
        bindThemeButtons();
        document.getElementById('login-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const submit = e.currentTarget.querySelector('button[type="submit"]');
          submit.disabled = true;
          await loginAdmin(document.getElementById('pin-input').value);
          submit.disabled = false;
        });
        document.getElementById('guest-btn').addEventListener('click', loginGuest);
        document.getElementById('player-login-form')?.addEventListener('submit', async event => {
          event.preventDefault();
          const submit = event.currentTarget.querySelector('button[type="submit"]');
          const error = document.getElementById('player-login-error');
          submit.disabled = true;
          error.classList.add('hidden');
          playerAuthError = '';
          try {
            const result = await requestPlayerApi('/api/player-auth/login', {
              method: 'POST',
              body: JSON.stringify({
                email: document.getElementById('player-login-email').value.trim(),
                password: document.getElementById('player-login-password').value
              })
            });
            applyPlayerAccount(result.player, result.mustChangePassword, 'tournaments');
            if (getRequestedPage() !== 'tournaments') {
              await navigateToPage('tournaments');
              return;
            }
            render();
            showToast('Signed in as Player', 'success');
          } catch (err) {
            error.textContent = err.message;
            error.classList.remove('hidden');
            submit.disabled = false;
          }
        });
        document.getElementById('register-player-type')?.addEventListener('change', event => {
          const existing = event.target.value === 'existing' && playerInviteContext?.roster.length > 0;
          document.getElementById('register-existing-player-wrap')?.classList.toggle('hidden', !existing);
          document.getElementById('register-new-player-wrap')?.classList.toggle('hidden', existing);
        });
        if (playerInviteContext && !playerInviteContext.invite.targetName) {
          document.getElementById('register-player-type')?.dispatchEvent(new Event('change'));
        }
        document.getElementById('player-register-form')?.addEventListener('submit', async event => {
          event.preventDefault();
          const submit = event.currentTarget.querySelector('button[type="submit"]');
          const password = document.getElementById('register-player-password').value;
          const confirmation = document.getElementById('register-player-password-confirm').value;
          if (password !== confirmation) {
            playerInviteError = 'Passwords do not match';
            const error = document.getElementById('player-register-error');
            error.textContent = playerInviteError;
            error.classList.remove('hidden');
            return;
          }
          const body = {
            inviteToken: playerInviteToken,
            email: document.getElementById('register-player-email').value.trim(),
            password
          };
          if (playerInviteContext.invite.targetName) {
            body.registrationType = 'player';
          } else if (document.getElementById('register-player-type').value === 'existing') {
            body.registrationType = 'existing';
            body.playerName = document.getElementById('register-existing-player').value;
          } else {
            body.registrationType = 'new';
            body.playerName = document.getElementById('register-new-player').value.trim();
          }
          submit.disabled = true;
          playerInviteError = '';
          try {
            const result = await requestPlayerApi('/api/player-auth/register', {
              method: 'POST',
              body: JSON.stringify(body)
            });
            applyPlayerAccount(result.player, false, 'tournaments');
            const url = new URL(window.location.href);
            url.searchParams.delete('playerInvite');
            history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
            if (getRequestedPage() !== 'tournaments') {
              await navigateToPage('tournaments');
              return;
            }
            render();
            showToast('Player account created', 'success');
          } catch (err) {
            playerInviteError = err.message;
            const error = document.getElementById('player-register-error');
            error.textContent = playerInviteError;
            error.classList.remove('hidden');
            submit.disabled = false;
          }
        });
      }

      function bindSetupWizardEvents() {
        document.querySelectorAll('[data-setup-step-nav]').forEach(button => {
          button.addEventListener('click', () => {
            const step = Number(button.getAttribute('data-setup-step-nav'));
            if (!Number.isInteger(step) || step < 1 || step > 5 || step === state.ui.setupStep) return;
            if (state.auth.role === 'admin' && state.ui.setupStep === 3) sortGroupsByName();
            state.ui.setupStep = step;
            if (state.auth.role === 'player') render();
            else {
              saveState();
              render();
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        });
      }

      function bindMatchViewEvents() {
        document.querySelectorAll('[data-qr1-filter]').forEach(button => {
          button.addEventListener('click', () => {
            state.ui.qr1GroupFilter = button.getAttribute('data-qr1-filter');
            render();
          });
        });
        document.querySelectorAll('[data-match-group]').forEach(group => {
          const button = group.querySelector('[data-match-toggle-all]');
          const matches = [...group.querySelectorAll('details[data-match]')];
          const updateButton = () => {
            const allOpen = matches.length > 0 && matches.every(match => match.open);
            const action = allOpen ? 'Collapse' : 'Expand';
            button.textContent = `${action} all matches`;
            button.setAttribute('aria-label', `${action} all matches in ${group.dataset.matchGroup}`);
            button.disabled = matches.length === 0;
          };
          button.addEventListener('click', () => {
            const open = !matches.every(match => match.open);
            matches.forEach(match => { match.open = open; });
            updateButton();
          });
          matches.forEach(match => match.addEventListener('toggle', updateButton));
          updateButton();
        });
      }

      function applyPlayerReadOnlyControls() {
        const safeSelectors = [
          '[data-tab]', '[data-player-select]', '#open-bracket-btn', '#player-refresh-btn',
          '[data-qr1-filter]', '[data-match-toggle-all]',
          '#player-directory-search', '#head-to-head-opponent', '#player-share-btn',
          '#player-edit-own-profile-btn', '#player-change-password-btn', '#player-delete-own-account-btn',
          '#player-self-checkin-btn', '#player-profile-shortcut', '[data-open-tournament]',
          '#tournament-history-refresh'
        ].join(',');
        document.querySelectorAll('main input, main select, main textarea, main button').forEach(control => {
          if (control.matches(safeSelectors)) return;
          control.disabled = true;
          control.classList.add('opacity-50', 'cursor-not-allowed');
        });
      }

      function bindPlayerAppEvents() {
        bindThemeButtons();
        bindSetupWizardEvents();
        bindPageLinks();
        bindMatchViewEvents();
        document.getElementById('logout-btn')?.addEventListener('click', async () => {
          try {
            await requestPlayerApi('/api/player-auth/logout', { method: 'POST' });
          } catch (err) {
            showToast(`Could not end the player session cleanly: ${err.message}`, 'error');
          }
          clearPlayerAccountProfile();
          state.auth.loggedIn = false;
          state.auth.role = 'guest';
          saveRegistry();
          render();
        });
        document.getElementById('tournament-switcher')?.addEventListener('change', event => switchTournament(event.target.value));
        document.getElementById('player-profile-shortcut')?.addEventListener('click', () => {
          if (playerAccountProfile) state.ui.selectedPlayerName = playerAccountProfile.name;
          navigateToPage('players');
        });
        document.querySelectorAll('[data-open-tournament]').forEach(button => {
          button.addEventListener('click', () => openTournamentFromCatalog(button.getAttribute('data-open-tournament')));
        });
        document.querySelectorAll('[data-delete-tournament]').forEach(button => {
          button.addEventListener('click', () => confirmTournamentDeletion(
            button.getAttribute('data-delete-tournament'),
            button.getAttribute('data-tournament-name') || 'Tournament'
          ));
        });
        document.getElementById('tournament-history-refresh')?.addEventListener('click', async event => {
          event.currentTarget.disabled = true;
          await loadTournamentCatalog(true);
          render();
        });
        document.getElementById('player-directory-search')?.addEventListener('input', event => {
          const query = event.target.value.toLocaleLowerCase().trim();
          document.querySelectorAll('[data-player-directory-name]').forEach(button => {
            button.classList.toggle('hidden', Boolean(query && !button.getAttribute('data-player-directory-name').includes(query)));
          });
        });
        document.querySelectorAll('[data-player-select]').forEach(button => {
          button.addEventListener('click', () => {
            state.ui.selectedPlayerName = button.getAttribute('data-player-select');
            if (window.PlayerAnalytics.normalizeName(state.ui.headToHeadOpponent) === window.PlayerAnalytics.normalizeName(state.ui.selectedPlayerName)) {
              state.ui.headToHeadOpponent = '';
            }
            render();
          });
        });
        document.getElementById('head-to-head-opponent')?.addEventListener('change', event => {
          state.ui.headToHeadOpponent = event.target.value;
          render();
        });
        document.querySelectorAll('[data-player-photo]').forEach(image => {
          image.addEventListener('error', () => image.remove(), { once: true });
        });
        document.getElementById('player-refresh-btn')?.addEventListener('click', async event => {
          event.currentTarget.disabled = true;
          await loadPlayerData(true);
          render();
        });
        document.getElementById('player-share-btn')?.addEventListener('click', () => {
          const shareUrl = new URL(window.location.href);
          shareUrl.searchParams.set('player', state.ui.selectedPlayerName);
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(shareUrl.toString())
              .then(() => showToast('Player card link copied', 'success'))
              .catch(() => showToast(shareUrl.toString()));
          } else {
            showToast(shareUrl.toString());
          }
        });
        document.getElementById('player-edit-own-profile-btn')?.addEventListener('click', () => {
          renderOwnPlayerProfileEditor(playerAccountProfile);
          bindOwnPlayerProfileEditor(playerAccountProfile.revision);
        });
        document.getElementById('player-change-password-btn')?.addEventListener('click', openPlayerPasswordChangeModal);
        document.getElementById('player-delete-own-account-btn')?.addEventListener('click', confirmPlayerAccountDeletion);
        document.getElementById('player-self-checkin-btn')?.addEventListener('click', async event => {
          const button = event.currentTarget;
          const rosterEntry = getOwnPlayerRosterEntry();
          if (!rosterEntry) return;
          if (checkInSaveInProgress || scoreSaveInProgress) {
            showToast('Wait for the current save to finish', 'error');
            return;
          }
          if (state.sync.status !== 'synced') {
            showToast('Reload the tournament before checking in', 'error');
            return;
          }
          checkInSaveInProgress = true;
          const app = document.getElementById('app');
          app.inert = true;
          button.disabled = true;
          try {
            const playerName = rosterEntry.name;
            const tournamentId = state.tournamentId;
            const result = await requestPlayerApi(`/api/player-auth/tournaments/${encodeURIComponent(tournamentId)}/checkin`, {
              method: 'POST',
              body: JSON.stringify({ playerName })
            });
            applyCheckInResult(result, tournamentId);
            render();
            showToast('You are checked in', 'success');
          } catch (err) {
            button.disabled = false;
            showToast(`Check-in could not be confirmed: ${err.message}. Refresh before retrying.`, 'error');
          } finally {
            checkInSaveInProgress = false;
            app.inert = false;
          }
        });
      }

      function bindOwnPlayerProfileEditor(revision) {
        bindProfilePhotoControls('own-profile');
        document.getElementById('player-own-profile-cancel')?.addEventListener('click', closeModal);
        document.getElementById('player-own-profile-form')?.addEventListener('submit', async event => {
          event.preventDefault();
          const submit = event.currentTarget.querySelector('button[type="submit"]');
          const photoUrl = getProfilePhotoValue('own-profile');
          if (photoUrl && !photoUrl.startsWith('data:')) {
            try {
              const parsed = new URL(photoUrl);
              if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
            } catch (_err) {
              showToast('Photo must be an HTTP or HTTPS URL', 'error');
              return;
            }
          }
          const profile = {
            name: document.getElementById('own-profile-name').value.trim(),
            nickname: document.getElementById('own-profile-nickname').value.trim(),
            photoUrl,
            gender: document.getElementById('own-profile-gender').value.trim(),
            club: document.getElementById('own-profile-club').value.trim(),
            skill: document.getElementById('own-profile-skill').value === '' ? null : Number(document.getElementById('own-profile-skill').value),
            country: document.getElementById('own-profile-country').value.trim(),
            state: document.getElementById('own-profile-state').value.trim(),
            city: document.getElementById('own-profile-city').value.trim(),
            emergencyContact: document.getElementById('own-profile-emergency').value.trim(),
            playingHand: document.getElementById('own-profile-hand').value,
            preferredEvents: [...document.querySelectorAll('[name="own-profile-event"]:checked')].map(input => input.value),
            email: document.getElementById('own-profile-email').value.trim(),
            visibility: Object.fromEntries([...document.querySelectorAll('[data-own-profile-visibility]')].map(input => [
              input.getAttribute('data-own-profile-visibility'), input.checked
            ]))
          };
          submit.disabled = true;
          try {
            const result = await requestPlayerApi('/api/player-auth/me', {
              method: 'PUT',
              headers: { 'x-player-revision': revision },
              body: JSON.stringify(profile)
            });
            applyPlayerAccount(result.player);
            closeModal();
            render();
            showToast('Player profile updated', 'success');
          } catch (err) {
            submit.disabled = false;
            showToast(`Could not update player profile: ${err.message}`, 'error');
          }
        });
      }

      async function openPlayerInvitesModal() {
        await loadPlayerData();
        const playerNames = [...new Set([
          ...playerData.profiles.map(profile => profile.name),
          ...window.PlayerAnalytics.buildAnalytics(playerData.tournaments, playerData.profiles, state.tournamentId).players.map(player => player.name)
        ])].sort((a, b) => a.localeCompare(b));
        let inviteList = [];
        let listError = '';
        try {
          inviteList = (await requestAdminApi('/api/player-invites')).invites || [];
        } catch (err) {
          listError = err.message;
        }
        openModal(`
          <div class="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-5">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h3 class="text-base font-bold">Player Invitations</h3>
                <p class="text-xs text-stone-500 mt-1">Generate links to share manually. No email or SMS is sent by the app.</p>
              </div>
              <button id="player-invites-close" type="button" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs">Close</button>
            </div>
            <form id="player-invite-create-form" class="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-xl bg-cream-50 dark:bg-[#111214] border border-stone-200 dark:border-stone-800">
              <label class="text-xs font-semibold text-stone-500">
                Invitation type
                <select id="player-invite-kind" class="mt-1 w-full px-3 py-2 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs">
                  <option value="player">Specific roster player (one use)</option>
                  <option value="generic">Reusable invitation</option>
                </select>
              </label>
              <label id="player-invite-player-wrap" class="text-xs font-semibold text-stone-500">
                Player
                <select id="player-invite-player" class="mt-1 w-full px-3 py-2 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs">
                  ${playerNames.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}
                </select>
                ${playerNames.length ? '' : '<span class="block mt-1 font-normal">No current players found; a specific invitation can create a profile with the entered name.</span>'}
                ${playerNames.length ? '' : '<input id="player-invite-new-name" type="text" maxlength="120" placeholder="Player full name" class="mt-2 w-full px-3 py-2 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs" />'}
              </label>
              <label class="text-xs font-semibold text-stone-500">
                Share method
                <select id="player-invite-contact-type" class="mt-1 w-full px-3 py-2 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs">
                  <option value="link">Copy link</option><option value="email">Email</option><option value="text">Text message</option>
                </select>
              </label>
              <label id="player-invite-contact-wrap" class="hidden text-xs font-semibold text-stone-500">
                <span id="player-invite-contact-label">Contact</span>
                <input id="player-invite-contact-value" type="text" maxlength="254" class="mt-1 w-full px-3 py-2 rounded-lg bg-white dark:bg-[#191B1F] border border-stone-300 dark:border-stone-700 text-xs" />
              </label>
              <p id="player-invite-error" role="alert" class="hidden sm:col-span-2 text-xs text-red-600 dark:text-red-400"></p>
              <div class="sm:col-span-2 flex justify-end">
                <button type="submit" class="px-4 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Generate Invitation Link</button>
              </div>
            </form>
            <div id="player-invite-created" class="hidden p-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 space-y-2"></div>
            <div>
              <h4 class="text-sm font-bold mb-2">Existing invitations</h4>
              ${listError ? `<p role="alert" class="text-xs text-red-600 dark:text-red-400">${esc(listError)}</p>` : inviteList.length ? `
                <div class="max-h-64 overflow-y-auto space-y-2">
                  ${inviteList.map(invite => {
                    const expired = Date.parse(invite.expiresAt) <= Date.now();
                    const exhausted = invite.maxUses !== null && Number(invite.usedCount) >= Number(invite.maxUses);
                    const active = !invite.revokedAt && !expired && !exhausted;
                    return `<div class="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg border border-stone-200 dark:border-stone-800 text-xs">
                      <div><b>${invite.kind === 'player' ? esc(invite.targetName) : 'Reusable invite'}</b>
                        <span class="text-stone-500"> · ${invite.contactType || 'link'}${invite.targetEmail ? ` · ${esc(invite.targetEmail)}` : ''}${invite.contactValue && invite.contactType === 'text' ? ` · ${esc(invite.contactValue)}` : ''}</span>
                        <div class="mt-1 text-[10px] text-stone-500">${Number(invite.usedCount)} used · expires ${esc(new Date(invite.expiresAt).toLocaleDateString())} · ${invite.revokedAt ? 'revoked' : expired ? 'expired' : exhausted ? 'used' : 'active'}</div>
                      </div>
                      ${active ? `<button type="button" data-revoke-player-invite="${esc(invite.id)}" class="px-2.5 py-1 rounded-lg border border-red-300 dark:border-red-900/60 text-red-600 dark:text-red-400">Revoke</button>` : ''}
                    </div>`;
                  }).join('')}
                </div>
              ` : '<p class="text-xs text-stone-500">No invitations created yet.</p>'}
            </div>
          </div>
        `);
        document.getElementById('player-invites-close').addEventListener('click', closeModal);
        const kindSelect = document.getElementById('player-invite-kind');
        const contactSelect = document.getElementById('player-invite-contact-type');
        const playerSelect = document.getElementById('player-invite-player');
        const newName = document.getElementById('player-invite-new-name');
        const playerWrap = document.getElementById('player-invite-player-wrap');
        const contactWrap = document.getElementById('player-invite-contact-wrap');
        const contactLabel = document.getElementById('player-invite-contact-label');
        const contactInput = document.getElementById('player-invite-contact-value');
        const updateInviteInputs = () => {
          playerWrap.classList.toggle('hidden', kindSelect.value !== 'player');
          const method = contactSelect.value;
          contactWrap.classList.toggle('hidden', method === 'link');
          contactLabel.textContent = method === 'email' ? 'Email address (registration must use this email)' : 'Phone number';
          contactInput.type = method === 'email' ? 'email' : 'tel';
          contactInput.required = method !== 'link';
          contactInput.placeholder = method === 'email' ? 'player@example.com' : '+1 555 123 4567';
        };
        kindSelect.addEventListener('change', updateInviteInputs);
        contactSelect.addEventListener('change', updateInviteInputs);
        updateInviteInputs();
        document.getElementById('player-invite-create-form').addEventListener('submit', async event => {
          event.preventDefault();
          const submit = event.currentTarget.querySelector('button[type="submit"]');
          const error = document.getElementById('player-invite-error');
          const contactType = contactSelect.value;
          const body = {
            kind: kindSelect.value,
            targetName: kindSelect.value === 'player' ? (newName?.value.trim() || playerSelect?.value || '') : '',
            contactType,
            contactValue: contactType === 'link' ? '' : contactInput.value.trim()
          };
          submit.disabled = true;
          error.classList.add('hidden');
          try {
            const result = await requestAdminApi('/api/player-invites', {
              method: 'POST',
              body: JSON.stringify(body)
            });
            const inviteUrl = new URL(window.location.href);
            inviteUrl.searchParams.delete('player');
            inviteUrl.searchParams.set('playerInvite', result.invite.token);
            const link = inviteUrl.toString();
            const shareAction = contactType === 'email'
              ? ` <a class="underline font-semibold" href="mailto:${encodeURIComponent(body.contactValue)}?subject=${encodeURIComponent('Player account invitation')}&body=${encodeURIComponent(`Create your player account: ${link}`)}">Open email</a>`
              : contactType === 'text'
                ? ` <a class="underline font-semibold" href="sms:${encodeURIComponent(body.contactValue)}?body=${encodeURIComponent(`Create your player account: ${link}`)}">Open text message</a>`
                : '';
            const created = document.getElementById('player-invite-created');
            created.innerHTML = `<div class="text-xs font-semibold">Invitation link generated. Share it manually; it expires in 30 days.</div>
              <div class="break-all text-[11px]">${esc(link)}</div>
              <div class="flex gap-3 text-xs"><button id="player-invite-copy" type="button" class="underline font-semibold">Copy link</button>${shareAction}</div>`;
            created.classList.remove('hidden');
            document.getElementById('player-invite-copy').addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(link);
                showToast('Player invitation link copied', 'success');
              } catch (_err) {
                showToast(link);
              }
            });
            showToast('Player invitation created', 'success');
          } catch (err) {
            error.textContent = err.message;
            error.classList.remove('hidden');
          } finally {
            submit.disabled = false;
          }
        });
        document.querySelectorAll('[data-revoke-player-invite]').forEach(button => {
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              await requestAdminApi(`/api/player-invites/${encodeURIComponent(button.getAttribute('data-revoke-player-invite'))}/revoke`, { method: 'POST' });
              closeModal();
              await openPlayerInvitesModal();
              showToast('Player invitation revoked', 'success');
            } catch (err) {
              button.disabled = false;
              showToast(`Could not revoke invitation: ${err.message}`, 'error');
            }
          });
        });
      }

      function loadSpreadsheetParser() {
        if (window.XLSX) return Promise.resolve(window.XLSX);
        if (spreadsheetParserPromise) return spreadsheetParserPromise;
        spreadsheetParserPromise = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
          script.async = true;
          script.onload = () => window.XLSX
            ? resolve(window.XLSX)
            : reject(new Error('The spreadsheet parser did not initialize'));
          script.onerror = () => {
            spreadsheetParserPromise = null;
            reject(new Error('Could not load the Excel parser. Check your connection and try again.'));
          };
          document.head.appendChild(script);
        });
        return spreadsheetParserPromise;
      }

      function readImportSheet(wizard) {
        const worksheet = wizard.workbook?.Sheets?.[wizard.sheetName];
        if (!worksheet) throw new Error('Choose a worksheet to continue');
        const matrix = window.XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '' });
        if (!matrix.length || !Array.isArray(matrix[0])) throw new Error('The worksheet is empty');
        wizard.headers = matrix[0].map((value, index) => String(value || '').trim() || `Column ${index + 1}`);
        wizard.rows = matrix.slice(1).filter(row => row.some(value => String(value ?? '').trim() !== ''));
        if (!wizard.headers.length) throw new Error('The first row must contain column headings');
        if (wizard.rows.length > 2000) throw new Error('Import up to 2,000 players at a time');
        wizard.mapping = Object.fromEntries(PLAYER_IMPORT_FIELDS.map(field => {
          const accepted = new Set([field.key, ...field.headers].map(normalizeImportHeader));
          const index = wizard.headers.findIndex(header => accepted.has(normalizeImportHeader(header)));
          return [field.key, index < 0 ? -1 : index];
        }));
      }

      function parseImportRows(wizard) {
        const entries = [];
        const errors = [];
        wizard.rows.forEach((row, index) => {
          const value = key => {
            const column = wizard.mapping[key];
            return column === undefined || column < 0 ? '' : String(row[column] ?? '').trim();
          };
          const sourceName = value('name');
          const hasData = PLAYER_IMPORT_FIELDS.some(field => value(field.key));
          if (!hasData) return;
          const rowNumber = index + 2;
          if (!sourceName) {
            errors.push({ rowNumber, sourceName: '', error: 'Player name is required' });
            return;
          }

          const sourcePlayerId = value('playerId');
          if (sourcePlayerId && !isValidPlayerId(sourcePlayerId)) {
            errors.push({ rowNumber, sourceName, error: 'Player ID must be a UUID' });
            return;
          }
          const sourcePlayerCode = value('playerCode');
          if (sourcePlayerCode && !/^\d{6}$/.test(sourcePlayerCode)) {
            errors.push({ rowNumber, sourceName, error: 'Player code must be a six-digit number' });
            return;
          }
          const rawAge = value('age');
          const age = rawAge ? Number(rawAge) : null;
          if (age !== null && (!Number.isInteger(age) || age < 1 || age > 120)) {
            errors.push({ rowNumber, sourceName, error: 'Age must be a whole number from 1 to 120' });
            return;
          }
          const email = value('email').toLowerCase();
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errors.push({ rowNumber, sourceName, error: 'Email address is invalid' });
            return;
          }
          const photoUrl = value('photoUrl');
          if (photoUrl) {
            try {
              if (!['http:', 'https:'].includes(new URL(photoUrl).protocol)) throw new Error();
            } catch (_err) {
              errors.push({ rowNumber, sourceName, error: 'Photo URL must use HTTP or HTTPS' });
              return;
            }
          }
          const rawHand = normalizeImportHeader(value('playingHand'));
          const playingHand = !rawHand ? '' :
            ['r', 'right', 'righthand', 'righthanded'].includes(rawHand) ? 'Right' :
              ['l', 'left', 'lefthand', 'lefthanded'].includes(rawHand) ? 'Left' : null;
          if (playingHand === null) {
            errors.push({ rowNumber, sourceName, error: 'Playing hand must be Right or Left' });
            return;
          }
          const preferredEvents = [];
          const eventError = value('preferredEvents').split(/[,;|/]/).map(event => event.trim()).filter(Boolean).some(event => {
            const normalized = normalizeImportName(event);
            const match = normalized === 'single' || normalized === 'singles' ? 'Singles' :
              normalized === 'double' || normalized === 'doubles' ? 'Doubles' :
                normalized === 'mixed' || normalized === 'mixed doubles' ? 'Mixed' : '';
            if (!match) return true;
            if (!preferredEvents.includes(match)) preferredEvents.push(match);
            return false;
          });
          if (eventError) {
            errors.push({ rowNumber, sourceName, error: 'Preferred events must be Singles, Doubles, or Mixed' });
            return;
          }
          const aliases = value('aliases').split(/[;,|]/).map(alias => alias.trim()).filter(Boolean);
          if (aliases.some(alias => alias.length > 120) || aliases.length > 30) {
            errors.push({ rowNumber, sourceName, error: 'Use up to 30 aliases, each 120 characters or fewer' });
            return;
          }
          entries.push({
            rowNumber,
            sourceName,
            profile: {
              name: sourceName,
              playerId: sourcePlayerId,
              playerCode: sourcePlayerCode,
              nickname: value('nickname'),
              email,
              club: value('club'),
              gender: value('gender'),
              country: value('country'),
              state: value('state'),
              city: value('city'),
              emergencyContact: value('emergencyContact'),
              playingHand,
              preferredEvents,
              photoUrl,
              age,
              ranking: value('ranking'),
              aliases
            }
          });
        });
        return { entries, errors };
      }

      function matchImportedPlayer(entry, directory) {
        const profile = entry.profile;
        const nameKeys = new Set([profile.name, ...(profile.aliases || [])].map(normalizeImportName).filter(Boolean));
        const signals = [];
        const addSignal = (matches, label) => {
          const unique = new Map(matches.map(item => [item.playerId || item.name, item]));
          if (unique.size > 1) throw new Error(`${label} matches more than one existing player`);
          if (unique.size) signals.push([...unique.values()][0]);
        };
        if (profile.playerId) {
          addSignal(directory.profiles.filter(item => String(item.playerId || '').toLowerCase() === profile.playerId.toLowerCase()), 'Player ID');
        }
        if (profile.playerCode) {
          addSignal(directory.profiles.filter(item => String(item.playerCode || '') === profile.playerCode), 'Player code');
        }
        addSignal(directory.profiles.filter(item => [
          item.name,
          item.nickname,
          ...(Array.isArray(item.aliases) ? item.aliases : [])
        ].some(name => nameKeys.has(normalizeImportName(name)))), 'Name or alias');
        const email = profile.email.toLocaleLowerCase();
        if (email) addSignal(directory.profiles.filter(item => String(item.email || '').trim().toLocaleLowerCase() === email), 'Email');
        const distinctProfiles = new Map(signals.map(item => [item.playerId || item.name, item]));
        if (distinctProfiles.size > 1) throw new Error('Name, email, or ID point to different existing players');
        const existingProfile = distinctProfiles.values().next().value || null;
        if (existingProfile) {
          return { existingProfile, canonicalName: existingProfile.name, existingRosterPlayer: true };
        }
        const rosterMatches = [...new Set(directory.rosterNames.filter(name => nameKeys.has(normalizeImportName(name))))];
        if (rosterMatches.length > 1) throw new Error('This name is ambiguous in existing tournament rosters');
        return {
          existingProfile: null,
          canonicalName: rosterMatches[0] || profile.name,
          existingRosterPlayer: rosterMatches.length > 0
        };
      }

      function prepareImportPreview(wizard) {
        const { entries, errors } = parseImportRows(wizard);
        const seen = new Set();
        const importRows = [];
        const previewRows = [];
        let duplicateRows = 0;
        entries.forEach(entry => {
          try {
            const match = matchImportedPlayer(entry, wizard.directory);
            const keys = [
              match.existingProfile?.playerId ? `id:${match.existingProfile.playerId.toLowerCase()}` : '',
              entry.profile.playerId ? `id:${entry.profile.playerId.toLowerCase()}` : '',
              entry.profile.playerCode ? `code:${entry.profile.playerCode}` : '',
              entry.profile.email ? `email:${entry.profile.email.toLocaleLowerCase()}` : '',
              `name:${normalizeImportName(match.canonicalName)}`
            ].filter(Boolean);
            if (keys.some(key => seen.has(key))) {
              duplicateRows++;
              previewRows.push({ ...entry, ...match, status: 'Duplicate row · skipped', duplicate: true });
              return;
            }
            keys.forEach(key => seen.add(key));
            const aliases = [...new Set([
              ...(entry.profile.aliases || []),
              normalizeImportName(entry.sourceName) !== normalizeImportName(match.canonicalName) ? entry.sourceName : ''
            ].filter(Boolean))];
            const profile = { ...entry.profile, name: match.canonicalName, aliases };
            const importEntry = { ...entry, ...match, profile };
            importRows.push(importEntry);
            previewRows.push({
              ...importEntry,
              status: match.existingProfile
                ? `Existing profile · code ${match.existingProfile.playerCode || 'will be assigned'}`
                : match.existingRosterPlayer
                  ? 'Existing tournament player · profile will be created'
                  : 'New player profile'
            });
          } catch (err) {
            errors.push({ rowNumber: entry.rowNumber, sourceName: entry.sourceName, error: err.message });
            previewRows.push({ ...entry, status: 'Needs attention' });
          }
        });
        errors.forEach(error => previewRows.push({ ...error, status: error.error }));
        wizard.importRows = importRows;
        wizard.previewRows = previewRows;
        wizard.validationErrors = errors;
        wizard.duplicateRows = duplicateRows;
      }

      function mergeImportedLocalProfile(entry) {
        const current = entry.existingProfile;
        const incoming = entry.profile;
        const aliases = [...new Set([
          ...(current?.aliases || []),
          ...(incoming.aliases || []),
          normalizeImportName(entry.sourceName) !== normalizeImportName(entry.canonicalName) ? entry.sourceName : ''
        ].filter(Boolean))];
        const savedProfile = current ? {
          ...current,
          name: current.name,
          playerId: current.playerId || incoming.playerId || createUniqueId(),
          playerCode: current.playerCode || incoming.playerCode,
          photoUrl: current.photoUrl || incoming.photoUrl,
          age: current.age ?? incoming.age,
          nickname: current.nickname || incoming.nickname,
          gender: current.gender || incoming.gender,
          club: current.club || incoming.club,
          country: current.country || incoming.country,
          state: current.state || incoming.state,
          city: current.city || incoming.city,
          emergencyContact: current.emergencyContact || incoming.emergencyContact,
          playingHand: current.playingHand || incoming.playingHand,
          preferredEvents: current.preferredEvents?.length ? current.preferredEvents : incoming.preferredEvents,
          email: current.email || incoming.email,
          ranking: current.ranking || incoming.ranking,
          aliases
        } : {
          ...incoming,
          name: entry.canonicalName,
          playerId: incoming.playerId || createUniqueId(),
          playerCode: incoming.playerCode || createPlayerCode(
            new Set(playerData.profiles.map(item => String(item.playerCode || '')).filter(Boolean))
          ),
          aliases
        };
        return cachePlayerProfile(savedProfile);
      }

      async function completePlayerImport(wizard, button) {
        button.disabled = true;
        button.textContent = 'Importing…';
        const closeButton = document.getElementById('player-import-close');
        if (closeButton) closeButton.disabled = true;
        try {
          let result;
          const apiUrl = getSyncApiUrl();
          if (apiUrl) {
            const response = await fetch(`${apiUrl}/api/player-import`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: getSyncHeaders(),
              body: JSON.stringify({ players: wizard.importRows.map(entry => entry.profile) })
            });
            let responseBody;
            try { responseBody = await response.json(); } catch (_err) {
              throw new Error(`Unexpected response from player import (HTTP ${response.status})`);
            }
            if (!response.ok) throw new Error(responseBody.error || `Player import failed (HTTP ${response.status})`);
            result = responseBody;
            (result.players || []).forEach(item => {
              if (item.profile) cachePlayerProfile(item.profile);
            });
          } else {
            const imported = wizard.importRows.map(entry => {
              const profile = mergeImportedLocalProfile(entry);
              return {
                name: profile.name,
                playerId: profile.playerId,
                status: entry.existingProfile ? 'matched' : entry.existingRosterPlayer ? 'existing-roster' : 'created',
                profile
              };
            });
            result = {
              players: imported,
              createdProfiles: imported.filter(item => item.status !== 'matched').length,
              matchedProfiles: imported.filter(item => item.status === 'matched').length,
              identifiedRosterPlayers: imported.filter(item => item.status === 'existing-roster').length,
              duplicateRows: wizard.duplicateRows
            };
          }
          const uniquePlayers = [];
          const identities = new Set();
          (result.players || []).forEach(player => {
            const identity = player.playerId || `name:${normalizeImportName(player.name)}`;
            if (!identities.has(identity)) {
              identities.add(identity);
              uniquePlayers.push(player);
            }
          });
          if (uniquePlayers.length < state.groups.length) {
            throw new Error(`Only ${uniquePlayers.length} unique players remain after duplicate matching. Import at least ${state.groups.length} to fill every group.`);
          }
          const existingRosterSkills = new Map();
          state.groups.flatMap(group => group.players).forEach(name => {
            const key = normalizeImportName(name);
            const skill = getPlayerSkill(name);
            existingRosterSkills.set(`name:${key}`, skill);
            const playerId = state.playerProfileIds?.[key];
            if (playerId) existingRosterSkills.set(`id:${playerId}`, skill);
          });
          state.groups.forEach(group => { group.players = []; group.leader = ''; });
          uniquePlayers.forEach((player, index) => {
            const group = state.groups[index % state.groups.length];
            group.players.push(player.name);
            const existingSkill = existingRosterSkills.get(`id:${player.playerId}`) ??
              existingRosterSkills.get(`name:${normalizeImportName(player.name)}`);
            setPlayerSkill(player.name, existingSkill ?? player.profile?.skill ?? 5);
            if (!group.leader) group.leader = player.name;
          });
          saveState();
          if (apiUrl) {
            clearTimeout(syncTimer);
            syncTimer = null;
            if (!await pushToTurso(false)) throw new Error('Tournament changes were not synced');
            await loadPlayerData(true);
          }
          wizard.closed = true;
          closeModal();
          render();
          const skippedDuplicates = wizard.duplicateRows + (result.duplicateRows || 0);
          showToast(
            `Imported ${uniquePlayers.length} unique players · ${result.createdProfiles || 0} profiles created · ${result.matchedProfiles || 0} existing profiles matched${skippedDuplicates ? ` · ${skippedDuplicates} duplicate rows skipped` : ''}`,
            'success'
          );
        } catch (err) {
          if (wizard.closed) return;
          wizard.error = err.message;
          renderImportWizard(wizard);
        }
      }

      function renderImportWizard(wizard) {
        if (wizard.closed) return;
        const stepLabels = ['Choose file', 'Match columns', 'Review import'];
        const directoryStatus = wizard.directoryLoading
          ? '<p class="text-xs text-stone-500">Checking existing players and tournament rosters…</p>'
          : wizard.directoryError
            ? `<p role="alert" class="text-xs text-red-600 dark:text-red-400">${esc(wizard.directoryError)}</p>`
            : `<p class="text-xs text-stone-500">${wizard.directory.profiles.length} profiles and ${wizard.directory.rosterNames.length} roster names will be checked for duplicates.</p>`;
        let content = '';
        if (wizard.step === 1) {
          content = `
            <div class="space-y-4">
              <label class="block text-xs font-semibold text-stone-600 dark:text-stone-300">
                Excel or CSV file
                <input id="player-import-file" type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" class="mt-1 block w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-cream-50 dark:bg-[#111214] p-3 text-xs" />
              </label>
              <p class="text-[11px] text-stone-500">The first worksheet row must contain column headings. Files are read in this browser; only mapped player details are sent to the app when you confirm.</p>
              ${wizard.fileName ? `<p class="text-xs font-medium">${esc(wizard.fileName)}</p>` : ''}
              ${wizard.sheetNames.length > 1 ? `
                <label class="block text-xs font-semibold text-stone-600 dark:text-stone-300">
                  Worksheet
                  <select id="player-import-sheet" class="mt-1 w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-cream-50 dark:bg-[#111214] p-2.5 text-sm">
                    ${wizard.sheetNames.map(name => `<option value="${esc(name)}" ${name === wizard.sheetName ? 'selected' : ''}>${esc(name)}</option>`).join('')}
                  </select>
                </label>` : ''}
              ${directoryStatus}
            </div>`;
        } else if (wizard.step === 2) {
          content = `
            <div class="space-y-3">
              <p class="text-xs text-stone-500">Match the spreadsheet headings to player profile fields. Player name is required; unmapped fields are left unchanged.</p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[48vh] overflow-y-auto pr-1">
                ${PLAYER_IMPORT_FIELDS.map(field => `
                  <label class="block text-xs font-semibold text-stone-600 dark:text-stone-300">
                    ${field.label}${field.required ? ' *' : ''}
                    <select data-player-import-field="${field.key}" class="mt-1 w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-cream-50 dark:bg-[#111214] p-2.5 text-sm">
                      <option value="-1">Do not import</option>
                      ${wizard.headers.map((header, index) => `<option value="${index}" ${wizard.mapping[field.key] === index ? 'selected' : ''}>${esc(header)}</option>`).join('')}
                    </select>
                  </label>
                `).join('')}
              </div>
            </div>`;
        } else {
          const newCount = wizard.importRows.filter(entry => !entry.existingProfile && !entry.existingRosterPlayer).length;
          const matchedCount = wizard.importRows.filter(entry => entry.existingProfile).length;
          const rosterCount = wizard.importRows.filter(entry => !entry.existingProfile && entry.existingRosterPlayer).length;
          const invalidCount = wizard.validationErrors.length;
          content = `
            <div class="space-y-4">
              <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                Import replaces this tournament’s roster. Existing player profiles and historical results are kept. Matching uses player ID, email, full name, and known aliases; repeated players are included only once.
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div class="rounded-lg bg-cream-50 dark:bg-[#111214] p-3"><b class="block text-lg">${wizard.importRows.length}</b><span class="text-[10px] text-stone-500">Unique roster players</span></div>
                <div class="rounded-lg bg-cream-50 dark:bg-[#111214] p-3"><b class="block text-lg">${newCount}</b><span class="text-[10px] text-stone-500">New profiles</span></div>
                <div class="rounded-lg bg-cream-50 dark:bg-[#111214] p-3"><b class="block text-lg">${matchedCount}</b><span class="text-[10px] text-stone-500">Existing profiles</span></div>
                <div class="rounded-lg bg-cream-50 dark:bg-[#111214] p-3"><b class="block text-lg">${rosterCount}</b><span class="text-[10px] text-stone-500">Roster-only players</span></div>
              </div>
              ${wizard.duplicateRows ? `<p class="text-xs text-amber-700 dark:text-amber-300">${wizard.duplicateRows} duplicate spreadsheet row(s) will be skipped.</p>` : ''}
              ${invalidCount ? `<div role="alert" class="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">${invalidCount} row(s) need correction before import: ${wizard.validationErrors.slice(0, 5).map(error => `Row ${error.rowNumber}: ${error.error}`).join('; ')}</div>` : ''}
              ${wizard.importRows.length < state.groups.length ? `<p role="alert" class="text-xs text-red-600 dark:text-red-400">At least ${state.groups.length} unique players are required to fill all groups.</p>` : ''}
              <div class="max-h-60 overflow-auto rounded-lg border border-stone-200 dark:border-stone-800">
                <table class="w-full text-left text-xs">
                  <thead class="sticky top-0 bg-cream-100 dark:bg-stone-800"><tr><th class="p-2">Row</th><th class="p-2">Spreadsheet name</th><th class="p-2">Matched player</th><th class="p-2">Result</th></tr></thead>
                  <tbody>
                    ${wizard.previewRows.slice(0, 40).map(entry => `
                      <tr class="border-t border-stone-200 dark:border-stone-800">
                        <td class="p-2 tabular-nums">${entry.rowNumber}</td>
                        <td class="p-2">${esc(entry.sourceName || '—')}</td>
                        <td class="p-2">${esc(entry.canonicalName || '—')}</td>
                        <td class="p-2">${esc(entry.status || '')}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>
              ${wizard.previewRows.length > 40 ? `<p class="text-[11px] text-stone-500">Showing 40 of ${wizard.previewRows.length} rows.</p>` : ''}
            </div>`;
        }

        const stepButtons = wizard.step === 1
          ? `<button id="player-import-next" type="button" ${!wizard.workbook || wizard.directoryLoading || wizard.directoryError ? 'disabled' : ''} class="min-h-11 rounded-lg bg-gold-500 px-4 py-2 text-sm font-bold text-stone-950 disabled:opacity-50">Match columns</button>`
          : wizard.step === 2
            ? `<button id="player-import-back" type="button" class="min-h-11 rounded-lg border border-stone-300 dark:border-stone-700 px-4 py-2 text-sm font-semibold">Back</button><button id="player-import-preview" type="button" class="min-h-11 rounded-lg bg-gold-500 px-4 py-2 text-sm font-bold text-stone-950">Review matches</button>`
            : `<button id="player-import-back" type="button" class="min-h-11 rounded-lg border border-stone-300 dark:border-stone-700 px-4 py-2 text-sm font-semibold">Back</button><button id="player-import-confirm" type="button" ${wizard.validationErrors.length || wizard.importRows.length < state.groups.length ? 'disabled' : ''} class="min-h-11 rounded-lg bg-gold-500 px-4 py-2 text-sm font-bold text-stone-950 disabled:opacity-50">Import &amp; create profiles</button>`;
        openModal(`
          <div class="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-4 sm:p-6 space-y-5">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h3 class="text-base font-bold">Import players from Excel</h3>
                <p class="mt-1 text-xs text-stone-500">Match players to existing profiles and tournament rosters before adding anyone.</p>
              </div>
              <button id="player-import-close" type="button" aria-label="Close import wizard" class="min-h-11 rounded-lg border border-stone-300 dark:border-stone-700 px-3 text-sm">Close</button>
            </div>
            <ol class="grid grid-cols-3 gap-2">
              ${stepLabels.map((label, index) => `
                <li class="rounded-lg p-2 text-center text-[11px] font-semibold ${wizard.step === index + 1 ? 'bg-gold-500/15 text-gold-700 dark:text-gold-300' : wizard.step > index + 1 ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-cream-100 dark:bg-stone-800 text-stone-500'}">${index + 1}. ${label}</li>
              `).join('')}
            </ol>
            ${wizard.error ? `<p role="alert" class="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">${esc(wizard.error)}</p>` : ''}
            ${content}
            <div class="flex flex-wrap justify-end gap-2 border-t border-stone-200 dark:border-stone-800 pt-4">
              ${stepButtons}
            </div>
          </div>
        `);

        document.getElementById('player-import-close').addEventListener('click', () => {
          wizard.closed = true;
          closeModal();
        });
        document.getElementById('player-import-file')?.addEventListener('change', async event => {
          const file = event.currentTarget.files?.[0];
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) {
            wizard.error = 'Choose a file smaller than 10 MB';
            renderImportWizard(wizard);
            return;
          }
          wizard.fileName = file.name;
          wizard.error = '';
          try {
            const XLSX = await loadSpreadsheetParser();
            wizard.workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
            wizard.sheetNames = wizard.workbook.SheetNames || [];
            if (!wizard.sheetNames.length) throw new Error('The workbook contains no worksheets');
            wizard.sheetName = wizard.sheetNames[0];
            readImportSheet(wizard);
          } catch (err) {
            wizard.workbook = null;
            wizard.error = err.message;
          }
          if (!wizard.closed) renderImportWizard(wizard);
        });
        document.getElementById('player-import-sheet')?.addEventListener('change', event => {
          wizard.sheetName = event.currentTarget.value;
          wizard.error = '';
          try { readImportSheet(wizard); } catch (err) { wizard.error = err.message; }
          renderImportWizard(wizard);
        });
        document.getElementById('player-import-next')?.addEventListener('click', () => {
          wizard.step = 2;
          wizard.error = '';
          renderImportWizard(wizard);
        });
        document.getElementById('player-import-back')?.addEventListener('click', () => {
          wizard.step--;
          wizard.error = '';
          renderImportWizard(wizard);
        });
        document.getElementById('player-import-preview')?.addEventListener('click', () => {
          wizard.mapping = Object.fromEntries([...document.querySelectorAll('[data-player-import-field]')].map(select => [
            select.getAttribute('data-player-import-field'),
            Number(select.value)
          ]));
          if (wizard.mapping.name === undefined || wizard.mapping.name < 0) {
            wizard.error = 'Map a spreadsheet column to Player name to continue';
            renderImportWizard(wizard);
            return;
          }
          try {
            prepareImportPreview(wizard);
            wizard.step = 3;
            wizard.error = '';
          } catch (err) {
            wizard.error = err.message;
          }
          renderImportWizard(wizard);
        });
        document.getElementById('player-import-confirm')?.addEventListener('click', event => {
          completePlayerImport(wizard, event.currentTarget);
        });
      }

      function openImportRosterModal() {
        const wizard = {
          step: 1,
          fileName: '',
          workbook: null,
          sheetNames: [],
          sheetName: '',
          headers: [],
          rows: [],
          mapping: {},
          directory: { profiles: [], rosterNames: [] },
          directoryLoading: true,
          directoryError: '',
          importRows: [],
          previewRows: [],
          validationErrors: [],
          duplicateRows: 0,
          error: ''
        };
        renderImportWizard(wizard);
        getPlayerImportDirectory().then(directory => {
          wizard.directory = directory;
        }).catch(err => {
          wizard.directoryError = err.message;
        }).finally(() => {
          wizard.directoryLoading = false;
          if (!wizard.closed) renderImportWizard(wizard);
        });
      }

      function movePlayerToGroup(fromGi, pi, toGi) {
        const from = state.groups[fromGi];
        const to = state.groups[toGi];
        const moved = from?.players?.[pi];
        if (!moved || !to || fromGi === toGi) return false;
        if (to.players.some(name => normalizeImportName(name) === normalizeImportName(moved))) {
          showToast(`${moved} is already in ${to.name}`, 'error');
          return false;
        }
        from.players.splice(pi, 1);
        if (from.leader === moved) from.leader = from.players[0] || '';
        to.players.push(moved);
        if (!to.leader) to.leader = moved;
        saveState();
        render();
        showToast(`Moved ${moved} to ${to.name}`, 'success');
        return true;
      }

      function bindPlayerDragAndDrop() {
        if (state.auth.role !== 'admin') return;
        document.querySelectorAll('[data-player-drag]').forEach(handle => {
          handle.addEventListener('dragstart', event => {
            const row = handle.closest('[data-player-row]');
            if (!event.dataTransfer || !row) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', handle.getAttribute('data-player-drag'));
            handle.setAttribute('aria-grabbed', 'true');
            row.classList.add('is-dragging');
          });
          handle.addEventListener('dragend', () => {
            handle.setAttribute('aria-grabbed', 'false');
            handle.closest('[data-player-row]')?.classList.remove('is-dragging');
            document.querySelectorAll('.player-drop-active').forEach(group => group.classList.remove('player-drop-active'));
          });
        });
        document.querySelectorAll('[data-player-drop-group]').forEach(group => {
          group.addEventListener('dragenter', event => {
            event.preventDefault();
            group.classList.add('player-drop-active');
          });
          group.addEventListener('dragover', event => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            group.classList.add('player-drop-active');
          });
          group.addEventListener('dragleave', event => {
            if (!group.contains(event.relatedTarget)) group.classList.remove('player-drop-active');
          });
          group.addEventListener('drop', event => {
            event.preventDefault();
            document.querySelectorAll('.player-drop-active').forEach(target => target.classList.remove('player-drop-active'));
            const match = /^(\d+):(\d+)$/.exec(event.dataTransfer?.getData('text/plain') || '');
            if (!match) return;
            movePlayerToGroup(Number(match[1]), Number(match[2]), Number(group.getAttribute('data-player-drop-group')));
          });
        });
      }

      async function promptNewTournament() {
        let open;
        try {
          open = await getOpenTournaments();
        } catch (err) {
          showToast(`Could not check open tournaments: ${err.message}`, 'error');
          return;
        }
        open.forEach(tournament => {
          if (!tournamentCatalog.items.some(item => String(item.id) === String(tournament.id))) {
            tournamentCatalog.items.push(tournament);
          }
        });
        if (open.length) {
          openModal(`
            <div role="dialog" aria-modal="true" aria-labelledby="open-tournament-title" class="w-full max-w-lg rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
              <h3 id="open-tournament-title" class="text-base font-bold">Close or delete open tournaments first</h3>
              <p class="text-sm text-stone-500">Only one tournament can be open at a time. Closing keeps its results; deleting permanently removes them.</p>
              <div class="space-y-3">${open.map((tournament, index) => `
                <div class="rounded-lg border border-stone-200 dark:border-stone-700 p-3 space-y-2">
                  <div class="font-semibold text-sm">${esc(tournament.name || 'Tournament')}</div>
                  <div class="text-xs text-stone-500">ID: ${esc(tournament.id)}</div>
                  <div class="flex gap-2">
                    <button type="button" data-close-open="${index}" class="px-3 py-2 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Close tournament</button>
                    <button type="button" data-delete-open="${index}" class="px-3 py-2 rounded-lg border border-red-300 text-red-600 text-xs font-bold">Delete tournament</button>
                  </div>
                </div>`).join('')}</div>
              <div class="flex justify-end"><button id="open-tournament-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 dark:border-stone-700 text-sm">Cancel</button></div>
            </div>
          `);
          document.getElementById('open-tournament-cancel').addEventListener('click', closeModal);
          document.querySelectorAll('[data-close-open]').forEach(button => button.addEventListener('click', () => {
            const tournament = open[Number(button.getAttribute('data-close-open'))];
            openModal(`
              <div role="alertdialog" aria-modal="true" aria-labelledby="close-tournament-title" class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
                <h3 id="close-tournament-title" class="text-base font-bold">Close tournament?</h3>
                <p class="text-sm text-stone-500">Close "${esc(tournament.name || 'Tournament')}" even if matches are incomplete? Its scores and history will be kept in Past Tournaments.</p>
                <div class="flex justify-end gap-2">
                  <button id="close-tournament-cancel" type="button" class="px-3 py-2 rounded-lg border border-stone-300 text-sm">Cancel</button>
                  <button id="close-tournament-confirm" type="button" class="px-3 py-2 rounded-lg bg-gold-500 text-stone-950 text-sm font-bold">Close tournament</button>
                </div>
              </div>
            `);
            document.getElementById('close-tournament-cancel').addEventListener('click', promptNewTournament);
            document.getElementById('close-tournament-confirm').addEventListener('click', async event => {
              event.currentTarget.disabled = true;
              try {
                await closeTournament(String(tournament.id));
                showToast('Tournament closed; results were preserved', 'success');
                await promptNewTournament();
              } catch (err) {
                event.currentTarget.disabled = false;
                showToast(`Could not close tournament: ${err.message}`, 'error');
              }
            });
          }));
          document.querySelectorAll('[data-delete-open]').forEach(button => button.addEventListener('click', () => {
            const tournament = open[Number(button.getAttribute('data-delete-open'))];
            confirmTournamentDeletion(String(tournament.id), tournament.name || 'Tournament', promptNewTournament);
          }));
          return;
        }
        openModal(`
          <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
            <h3 class="text-base font-bold">Create New Tournament</h3>
            <div class="space-y-3 text-xs">
              <div>
                <label class="block font-semibold text-stone-500 mb-1">Tournament Name</label>
                <input id="new-t-name" type="text" placeholder="Spring Open Badminton Tournament" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm" />
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div><label class="block font-semibold text-stone-500 mb-1">Date</label><input id="new-t-date" type="date" value="${esc(state.config.date)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs" /></div>
                <div><label class="block font-semibold text-stone-500 mb-1">Venue</label><input id="new-t-venue" type="text" value="${esc(state.config.venue)}" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs" /></div>
              </div>
            </div>
            <div class="flex justify-end gap-2 pt-1">
              <button id="modal-cancel" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
              <button id="new-t-confirm" class="px-4 py-1.5 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Create</button>
            </div>
          </div>
        `);
        document.getElementById('modal-cancel').addEventListener('click', closeModal);
        document.getElementById('new-t-confirm').addEventListener('click', async event => {
          const button = event.currentTarget;
          button.disabled = true;
          const name = document.getElementById('new-t-name').value.trim() || 'New Badminton Tournament';
          const date = document.getElementById('new-t-date').value;
          const venue = document.getElementById('new-t-venue').value.trim();
          try {
            if ((await getOpenTournaments()).length) {
              await promptNewTournament();
              return;
            }
            if (await createNewTournament(name, date, venue)) {
              closeModal();
              showToast(`Created "${name}"`, 'success');
            } else if ((await getOpenTournaments()).length) {
              await promptNewTournament();
            } else {
              button.disabled = false;
            }
          } catch (err) {
            button.disabled = false;
            showToast(`Could not create tournament: ${err.message}`, 'error');
          }
        });
      }

      function bindAppEvents() {
        bindThemeButtons();
        bindSetupWizardEvents();
        bindPlayerDragAndDrop();
        bindPageLinks();
        bindMatchViewEvents();
        document.getElementById('logout-btn')?.addEventListener('click', logout);
        document.getElementById('tournament-switcher')?.addEventListener('change', (e) => {
          switchTournament(e.target.value);
        });
        document.querySelectorAll('[data-open-tournament]').forEach(button => {
          button.addEventListener('click', () => openTournamentFromCatalog(button.getAttribute('data-open-tournament')));
        });
        document.querySelectorAll('[data-delete-tournament]').forEach(button => {
          button.addEventListener('click', () => confirmTournamentDeletion(
            button.getAttribute('data-delete-tournament'),
            button.getAttribute('data-tournament-name') || 'Tournament'
          ));
        });
        document.getElementById('tournament-history-refresh')?.addEventListener('click', async event => {
          event.currentTarget.disabled = true;
          await loadTournamentCatalog(true);
          render();
        });
        document.getElementById('new-tournament-btn')?.addEventListener('click', promptNewTournament);
        document.getElementById('open-sync-modal-btn')?.addEventListener('click', () => {
          openModal(`
            <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
              <h3 class="text-base font-bold">SQLite Cloud Sync</h3>
              <p class="text-xs text-stone-500 dark:text-stone-400">This Vercel deployment uses its own API by default. Connect a different hosted SQLite-compatible backend only if needed.</p>
              <div class="space-y-3 text-xs">
                <div>
                  <label class="block font-semibold text-stone-500 mb-1">Backend API URL (optional)</label>
                  <input id="sync-api-url" type="url" value="${esc(state.sync?.apiUrl || '')}" placeholder="Leave blank to use this Vercel deployment" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs" />
                </div>
                ${usesAdminSession() ? '' : `<div>
                  <label class="block font-semibold text-stone-500 mb-1">Admin Sync Key</label>
                  <input id="sync-api-key" type="password" value="${esc(state.sync?.syncKey || '')}" placeholder="Required when ADMIN_SYNC_KEY is set on the backend" autocomplete="off" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs" />
                  <p class="mt-1 text-[11px] text-stone-500">Enter the same value configured in the backend’s <code>.env</code> file or Vercel environment. For local use, open the app on port 3001; the 8080 preview now connects to that backend.</p>
                </div>`}
              </div>
              <div class="flex flex-wrap justify-between gap-2 pt-1">
                <button id="modal-cancel" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Close</button>
                <div class="flex gap-2">
                  <button id="sync-pull-btn" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-semibold">Pull from DB</button>
                  <button id="sync-save-push-btn" class="px-3.5 py-1.5 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Save &amp; Push</button>
                </div>
              </div>
            </div>
          `);
          document.getElementById('modal-cancel').addEventListener('click', closeModal);
          const saveInputs = async () => {
            if (!state.sync) state.sync = { apiUrl: '', syncKey: '', status: 'local', lastSynced: null };
            const previousUrl = state.sync.apiUrl;
            const previousSession = usesAdminSession();
            const nextUrl = (document.getElementById('sync-api-url').value || '').trim().replace(/\/+$/, '');
            if (nextUrl) {
              try {
                new URL(nextUrl);
              } catch (_err) {
                showToast('Enter a valid backend URL', 'error');
                return false;
              }
            }
            state.sync.apiUrl = nextUrl;
            const validUrl = getSyncApiUrl();
            const nextSession = usesAdminSession();
            state.sync.apiUrl = previousUrl;
            if (nextUrl && !validUrl) {
              showToast('Enter an HTTPS backend URL or a localhost HTTP URL', 'error');
              return false;
            }
            if (previousSession !== nextSession) {
              if (syncTimer || syncInFlight || ['pending', 'syncing', 'error'].includes(state.sync.status)) {
                showToast('Resolve unsynced changes before changing the backend', 'error');
                return false;
              }
              if (previousSession) {
                try {
                  await requestAdminSession('/api/admin-auth/logout', { method: 'POST' });
                } catch (err) {
                  showToast(`Could not end the admin session: ${err.message}`, 'error');
                  return false;
                }
              }
              state.sync.apiUrl = nextUrl;
              state.auth.loggedIn = false;
              state.auth.role = 'guest';
              saveRegistry();
              closeModal();
              render();
              showToast('Backend changed. Sign in again to continue.', 'success');
              return false;
            }
            state.sync.apiUrl = nextUrl;
            const keyInput = document.getElementById('sync-api-key');
            if (keyInput) state.sync.syncKey = keyInput.value.trim();
            saveRegistry();
            return true;
          };
          document.getElementById('sync-pull-btn').addEventListener('click', async () => {
            if (!await saveInputs()) return;
            closeModal();
            await pullFromTurso(false);
          });
          document.getElementById('sync-save-push-btn').addEventListener('click', async () => {
            if (!await saveInputs()) return;
            closeModal();
            await pushToTurso(false);
            render();
          });
        });
        document.getElementById('launch-kiosk-btn')?.addEventListener('click', () => {
          state.ui.playerCheckInMode = true;
          render();
        });
        document.getElementById('show-qr-modal-btn')?.addEventListener('click', () => {
          const checkinUrl = new URL(PAGE_FILES.checkin, window.location.href);
          checkinUrl.searchParams.set('t', state.tournamentId || 'default');
          if (state.sync?.apiUrl) checkinUrl.searchParams.set('api', state.sync.apiUrl);
          checkinUrl.hash = 'checkin';
          const checkinLink = checkinUrl.toString();
          openModal(`
            <div class="w-full max-w-sm rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4 text-center">
              <h3 class="text-base font-bold">Player Check-In QR Code</h3>
              <p class="text-xs text-stone-500 dark:text-stone-400">Players can scan this QR code to open the sign-in screen.</p>
              <div id="qr-code-box" class="mx-auto w-48 h-48 bg-white p-3 rounded-xl flex items-center justify-center border border-stone-200"></div>
              <div class="text-[11px] font-mono text-stone-500 break-all">${esc(checkinLink)}</div>
              <div class="flex justify-center gap-2">
                <button id="copy-qr-url-btn" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Copy Link</button>
                <button id="modal-cancel" class="px-4 py-1.5 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Done</button>
              </div>
            </div>
          `);
          const box = document.getElementById('qr-code-box');
          if (typeof QRCode !== 'undefined' && box) {
            new QRCode(box, { text: checkinLink, width: 168, height: 168 });
          } else if (box) {
            box.innerHTML = '<span class="text-xs text-stone-500">QR library loading...</span>';
          }
          document.getElementById('modal-cancel').addEventListener('click', closeModal);
          document.getElementById('copy-qr-url-btn').addEventListener('click', () => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(checkinLink).then(() => showToast('Check-in link copied', 'success'));
            } else {
              showToast(checkinLink);
            }
          });
        });
        document.querySelectorAll('[data-checkin-filter]').forEach(btn => {
          btn.addEventListener('click', () => {
            state.ui.checkInFilter = btn.getAttribute('data-checkin-filter');
            render();
          });
        });
        document.getElementById('checkin-table-search')?.addEventListener('input', (e) => {
          state.ui.checkInSearch = e.target.value;
          render();
          const inp = document.getElementById('checkin-table-search');
          if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
        });
        document.getElementById('checkin-group-filter')?.addEventListener('change', (e) => {
          state.ui.checkInGroupFilter = e.target.value;
          render();
        });
        document.getElementById('checkin-skill-min')?.addEventListener('change', (e) => {
          state.ui.checkInSkillMin = e.target.value;
          render();
        });
        document.getElementById('checkin-skill-max')?.addEventListener('change', (e) => {
          state.ui.checkInSkillMax = e.target.value;
          render();
        });
        document.getElementById('checkin-clear-filters')?.addEventListener('click', () => {
          state.ui.checkInFilter = 'ALL';
          state.ui.checkInSearch = '';
          state.ui.checkInGroupFilter = 'ALL';
          state.ui.checkInSkillMin = '';
          state.ui.checkInSkillMax = '';
          render();
        });
        document.getElementById('ci-import-btn')?.addEventListener('click', () => {
          openImportRosterModal();
        });
        document.getElementById('ci-add-btn')?.addEventListener('click', async event => {
          const button = event.currentTarget;
          const name = document.getElementById('ci-add-name')?.value.trim();
          const gi = Number(document.getElementById('ci-add-group')?.value || 0);
          const skillInput = document.getElementById('ci-add-skill');
          const rawSkill = skillInput?.value || '';
          const autoSignIn = document.getElementById('ci-add-signedin')?.checked;
          if (!name) { showToast('Enter a player name', 'error'); return; }
          if (rawSkill && (!Number.isInteger(Number(rawSkill)) || Number(rawSkill) < 1 || Number(rawSkill) > 10)) {
            showToast('Skill must be a whole number between 1 and 10', 'error');
            return;
          }
          let skill = rawSkill ? Number(rawSkill) : null;
          if (skill === null) {
            button.disabled = true;
            try {
              const { profiles } = await getPlayerImportDirectory();
              const matches = profiles.filter(profile => [profile.name, ...(profile.aliases || [])]
                .some(value => normalizeImportName(value) === normalizeImportName(name)));
              if (matches.length > 1) throw new Error('Player name matches multiple profiles; enter a skill override');
              skill = matches[0]?.skill ?? 5;
            } catch (err) {
              showToast(`Could not load player skill: ${err.message}`, 'error');
              return;
            } finally {
              button.disabled = false;
            }
          }
          state.groups[gi].players.push(name);
          if (!state.groups[gi].leader) state.groups[gi].leader = name;
          setPlayerSkill(name, skill);
          saveState();
          try {
            if (autoSignIn) await syncCheckInToServer(name, true, 'desk');
            render();
            showToast(`Added ${name} to ${state.groups[gi].name}${autoSignIn ? ' and checked in' : ''}`, 'success');
          } catch (err) {
            render();
            showToast(`Check-in could not be confirmed: ${err.message}. Check the roster and refresh before retrying.`, 'error');
          }
        });
        document.querySelectorAll('[data-ci-leader]').forEach(btn => {
          btn.addEventListener('click', () => {
            const [gi, pi] = btn.getAttribute('data-ci-leader').split(':').map(Number);
            state.groups[gi].leader = state.groups[gi].players[pi];
            saveState();
            render();
          });
        });
        document.querySelectorAll('[data-ci-edit-name]').forEach(inp => {
          inp.addEventListener('change', () => {
            const [gi, pi] = inp.getAttribute('data-ci-edit-name').split(':').map(Number);
            renamePlayerEverywhere(gi, pi, inp.value);
            saveState();
            render();
          });
        });
        document.querySelectorAll('[data-ci-move-group]').forEach(sel => {
          sel.addEventListener('change', () => {
            const [fromGi, pi] = sel.getAttribute('data-ci-move-group').split(':').map(Number);
            const toGi = Number(sel.value);
            if (fromGi === toGi) return;
            const moved = state.groups[fromGi].players.splice(pi, 1)[0];
            if (state.groups[fromGi].leader === moved) state.groups[fromGi].leader = state.groups[fromGi].players[0] || '';
            state.groups[toGi].players.push(moved);
            if (!state.groups[toGi].leader) state.groups[toGi].leader = moved;
            saveState();
            render();
          });
        });
        document.querySelectorAll('[data-ci-edit-skill]').forEach(inp => {
          inp.addEventListener('change', () => {
            setPlayerSkill(inp.getAttribute('data-ci-edit-skill'), inp.value);
            saveState();
            render();
          });
        });
        document.querySelectorAll('[data-ci-edit-time]').forEach(inp => {
          inp.addEventListener('change', async () => {
            const name = inp.getAttribute('data-ci-edit-time');
            if (state.checkIns?.[name]) {
              const time = inp.value.trim();
              if (!time) {
                inp.value = state.checkIns[name].time || '';
                showToast('Enter a check-in time', 'error');
                return;
              }
              try {
                await syncCheckInToServer(name, true, state.checkIns[name].source || 'desk', time);
                render();
                showToast(`Updated check-in time for ${name}`, 'success');
              } catch (err) {
                inp.value = state.checkIns[name]?.time || '';
                showToast(`Check-in time could not be confirmed: ${err.message}. Refresh before retrying.`, 'error');
              }
            }
          });
        });
        document.querySelectorAll('[data-ci-remove]').forEach(btn => {
          btn.addEventListener('click', () => {
            const [gi, pi] = btn.getAttribute('data-ci-remove').split(':').map(Number);
            const removed = state.groups[gi].players.splice(pi, 1)[0];
            if (state.groups[gi].leader === removed) state.groups[gi].leader = state.groups[gi].players[0] || '';
            saveState();
            render();
            showToast(`Removed ${removed}`);
          });
        });
        document.querySelectorAll('[data-toggle-checkin]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const name = btn.getAttribute('data-toggle-checkin');
            const checkedIn = !state.checkIns?.[name]?.checkedIn;
            try {
              await syncCheckInToServer(name, checkedIn, 'desk');
              render();
              showToast(checkedIn ? `Checked in ${name}` : `Removed check-in for ${name}`, 'success');
            } catch (err) {
              showToast(`Check-in for ${name} could not be confirmed: ${err.message}. Refresh before retrying.`, 'error');
            }
          });
        });

        document.getElementById('player-directory-search')?.addEventListener('input', (event) => {
          state.ui.playerSearch = event.target.value;
          const query = state.ui.playerSearch.toLocaleLowerCase().trim();
          document.querySelectorAll('[data-player-directory-name]').forEach(button => {
            button.classList.toggle('hidden', Boolean(query && !button.getAttribute('data-player-directory-name').includes(query)));
          });
        });
        document.querySelectorAll('[data-player-select]').forEach(button => {
          button.addEventListener('click', () => {
            state.ui.selectedPlayerName = button.getAttribute('data-player-select');
            if (window.PlayerAnalytics.normalizeName(state.ui.headToHeadOpponent) === window.PlayerAnalytics.normalizeName(state.ui.selectedPlayerName)) {
              state.ui.headToHeadOpponent = '';
            }
            saveRegistry();
            render();
          });
        });
        document.getElementById('head-to-head-opponent')?.addEventListener('change', event => {
          state.ui.headToHeadOpponent = event.target.value;
          saveRegistry();
          render();
        });
        document.querySelectorAll('[data-player-photo]').forEach(image => {
          image.addEventListener('error', () => image.remove(), { once: true });
        });
        document.getElementById('player-refresh-btn')?.addEventListener('click', async event => {
          event.currentTarget.disabled = true;
          await loadPlayerData(true);
          render();
        });
        document.getElementById('player-add-profile-btn')?.addEventListener('click', () => renderPlayerProfileEditor(null));
        document.getElementById('player-bulk-delete-btn')?.addEventListener('click', () => {
          openBulkPlayerDeletion().catch(err => showToast(`Could not load players for deletion: ${err.message}`, 'error'));
        });
        document.getElementById('player-invites-btn')?.addEventListener('click', () => {
          openPlayerInvitesModal().catch(err => showToast(`Could not open player invitations: ${err.message}`, 'error'));
        });
        document.getElementById('player-edit-profile-btn')?.addEventListener('click', async event => {
          const selectedName = event.currentTarget.getAttribute('data-player-edit-name') || state.ui.selectedPlayerName;
          try {
            const profiles = getSyncApiUrl()
              ? (await requestAdminApi('/api/player-import/directory')).profiles
              : getLocalPlayerProfiles();
            const profile = profiles.find(item => samePlayerIdentity(item, { name: selectedName }));
            if (!profile) throw new Error('Player profile no longer exists; refresh the directory');
            renderPlayerProfileEditor(profile);
          } catch (err) {
            showToast(`Could not load player profile: ${err.message}`, 'error');
          }
        });
        document.getElementById('player-reset-password-btn')?.addEventListener('click', event => {
          resetPlayerPassword(event.currentTarget.getAttribute('data-player-account-name'));
        });
        document.getElementById('player-delete-account-btn')?.addEventListener('click', event => {
          confirmAdminDeletePlayerLogin(event.currentTarget.getAttribute('data-player-account-name'));
        });
        document.getElementById('player-delete-profile-btn')?.addEventListener('click', event => {
          const name = event.currentTarget.getAttribute('data-player-delete-name');
          const profile = playerData.profiles.find(item => samePlayerIdentity(item, { name }));
          if (!profile?.playerId || !profile.revision) {
            showToast('Reload the player directory before deleting this profile', 'error');
            return;
          }
          confirmAdminDeletePlayerProfile(profile);
        });
        document.getElementById('player-share-btn')?.addEventListener('click', () => {
          const shareUrl = new URL(window.location.href);
          shareUrl.searchParams.set('player', state.ui.selectedPlayerName);
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareUrl.toString())
              .then(() => showToast('Player card link copied', 'success'))
              .catch(() => showToast(shareUrl.toString()));
          } else {
            showToast(shareUrl.toString());
          }
        });
        // Header Admin Actions
        document.getElementById('export-btn')?.addEventListener('click', () => {
          const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'badminton-tournament.json';
          a.click();
          URL.revokeObjectURL(url);
          showToast('Exported tournament JSON', 'success');
        });

        document.getElementById('share-btn')?.addEventListener('click', () => {
          const summary = `${state.config.name} (${state.config.date}) — Phase: ${state.phase.toUpperCase()}`;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(summary).then(() => showToast('Copied tournament summary', 'success')).catch(() => showToast(summary));
          } else {
            showToast(summary);
          }
        });

        document.getElementById('import-roster-btn')?.addEventListener('click', openImportRosterModal);

        document.getElementById('reset-btn')?.addEventListener('click', () => {
          openModal(`
            <div class="w-full max-w-sm rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
              <h3 class="text-base font-bold">Reset tournament matches?</h3>
              <p class="text-xs text-stone-500">This clears all match schedules, scores, and results for this tournament and returns it to setup. Tournament settings, groups, players, skills, and attendance are preserved. Start the tournament again to generate a new schedule.</p>
              <div class="flex justify-end gap-2">
                <button id="modal-cancel" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
                <button id="modal-reset-confirm" class="px-4 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold">Reset Matches</button>
              </div>
            </div>
          `);
          document.getElementById('modal-cancel').addEventListener('click', closeModal);
          document.getElementById('modal-reset-confirm').addEventListener('click', async event => {
            const button = event.currentTarget;
            button.disabled = true;
            const previous = state;
            if (getSyncApiUrl()) {
              if (state.sync.status === 'error') {
                showToast('Resolve the tournament sync error before resetting', 'error');
                button.disabled = false;
                return;
              }
              if (syncTimer || syncInFlight || state.sync.status === 'pending') {
                do {
                  clearTimeout(syncTimer);
                  syncTimer = null;
                  if (!await pushToTurso(true)) {
                    button.disabled = false;
                    return;
                  }
                } while (state.sync.status === 'pending');
              }
            }
            if (state.phase === 'completed') {
              try {
                if ((await getOpenTournaments()).some(tournament => String(tournament.id) !== String(previous.tournamentId))) {
                  showToast('Close or delete the open tournament before reopening this tournament', 'error');
                  button.disabled = false;
                  return;
                }
              } catch (err) {
                showToast(`Could not check open tournaments: ${err.message}`, 'error');
                button.disabled = false;
                return;
              }
              if (state !== previous) return;
            }
            if (state !== previous) {
              showToast('Tournament changed while resetting; try again', 'error');
              button.disabled = false;
              return;
            }
            const resetState = {
              ...previous,
              phase: 'setup',
              qr1Matches: [],
              qr2Pools: {},
              qr2Matches: {},
              semis: {},
              finals: {},
              sync: { ...previous.sync },
              ui: { ...previous.ui, activeTab: getRequestedPage() }
            };
            delete resetState.closedEarly;
            state = resetState;
            if (getSyncApiUrl()) {
              syncGeneration++;
              if (!await pushToTurso(true, false, true)) {
                if (state === resetState) {
                  state = previous;
                  state.sync.status = 'error';
                  saveRegistry();
                  closeModal();
                  render();
                }
                return;
              }
            } else {
              saveState();
            }
            closeModal();
            render();
            showToast('Tournament matches reset', 'success');
          });
        });

        // Setup bindings
        document.getElementById('cfg-num-groups')?.addEventListener('change', (e) => syncGroupCount(parseInt(e.target.value, 10) || 5));
        document.getElementById('cfg-total-players')?.addEventListener('change', event => {
          const input = event.currentTarget;
          if (state.auth.role !== 'admin') return;
          const count = input.valueAsNumber;
          if (input.value !== '' && (!Number.isSafeInteger(count) || count < 0)) {
            showToast('Rostered players target must be a non-negative whole number', 'error');
            input.value = state.config.rosterTarget ?? state.groups.reduce((sum, group) => sum + group.players.length, 0);
            return;
          }
          state.config.rosterTarget = input.value === '' ? null : count;
          saveState();
          render();
        });
        document.getElementById('cfg-players-per-group')?.addEventListener('change', (e) => {
          const ppg = Math.max(4, Math.min(12, parseInt(e.target.value, 10) || 6));
          state.config.playersPerGroup = ppg;
          saveState();
          render();
        });
        document.querySelectorAll('[data-rk-num]').forEach(el => {
          el.addEventListener('change', () => {
            if (!state.config.ranking) state.config.ranking = { winPointsWeight: 20, winMarginWeight: 1, lossMarginWeight: 1, tiebreakers: ['wp', 'wins', 'pf', 'pa'] };
            state.config.ranking[el.getAttribute('data-rk-num')] = parseFloat(el.value) || 0;
            saveState();
          });
        });
        document.querySelectorAll('[data-rk-tb]').forEach(sel => {
          sel.addEventListener('change', () => {
            if (!state.config.ranking) state.config.ranking = { winPointsWeight: 20, winMarginWeight: 1, lossMarginWeight: 1, tiebreakers: ['wp', 'wins', 'pf', 'pa'] };
            const idx = Number(sel.getAttribute('data-rk-tb'));
            state.config.ranking.tiebreakers[idx] = sel.value;
            saveState();
          });
        });
        document.getElementById('sort-groups-btn')?.addEventListener('click', () => {
          sortGroupsByName();
          saveState();
          render();
          showToast('Groups sorted by name', 'success');
        });
        document.getElementById('add-group-btn')?.addEventListener('click', () => {
          if (state.groups.length >= 8) { showToast('Maximum 8 groups supported', 'error'); return; }
          syncGroupCount(state.groups.length + 1);
        });
        document.querySelectorAll('[data-remove-group]').forEach(btn => {
          btn.addEventListener('click', () => {
            if (state.groups.length <= 2) return;
            const gi = Number(btn.getAttribute('data-remove-group'));
            state.groups.splice(gi, 1);
            state.config.numGroups = state.groups.length;
            saveState();
            render();
          });
        });
        document.querySelectorAll('[data-group-name]').forEach(inp => {
          inp.addEventListener('change', () => {
            const gi = Number(inp.getAttribute('data-group-name'));
            const candidate = inp.value.trim();
            if (!candidate) { inp.value = state.groups[gi].name; return; }
            const duplicate = state.groups.some((g, idx) => idx !== gi && g.name.trim().toLowerCase() === candidate.toLowerCase());
            if (duplicate) {
              showToast(`Group name "${candidate}" already exists`, 'error');
              inp.value = state.groups[gi].name;
              return;
            }
            state.groups[gi].name = candidate;
            saveState();
          });
        });
        document.querySelectorAll('[data-move-player]').forEach(sel => {
          sel.addEventListener('change', () => {
            const [fromGi, pi] = sel.getAttribute('data-move-player').split(':').map(Number);
            movePlayerToGroup(fromGi, pi, Number(sel.value));
          });
        });
        document.querySelectorAll('[data-cfg]').forEach(el => {
          el.addEventListener('change', () => {
            state.config[el.getAttribute('data-cfg')] = el.value;
            saveState();
          });
        });
        document.querySelectorAll('[data-cfg-num]').forEach(el => {
          el.addEventListener('change', () => {
            const field = el.getAttribute('data-cfg-num');
            state.config[field] = parseInt(el.value, 10) || 1;
            saveState();
            if (field === 'qr2PoolsCount') render();
          });
        });
        [
          { id: 'cfg-qr1-matches', field: 'matchesPerPlayer', label: 'Round 1', max: 9 },
          { id: 'cfg-qr2-matches', field: 'qr2MatchesPerPlayer', label: 'Round 2', max: 79 }
        ].forEach(({ id, field, label, max }) => {
          document.getElementById(id)?.addEventListener('change', event => {
            const input = event.currentTarget;
            const count = input.valueAsNumber;
            if (!Number.isInteger(count) || count < 1 || count > max) {
              showToast(`${label} matches per player must be a whole number between 1 and ${max}`, 'error');
              input.value = state.config[field] ?? state.config.matchesPerPlayer;
              return;
            }
            state.config[field] = count;
            saveState();
            render();
          });
        });
        document.querySelectorAll('[data-pool-final-format]').forEach(el => {
          el.addEventListener('change', () => {
            const groupKey = el.getAttribute('data-pool-final-format');
            const format = el.value === 'bo3' ? 'bo3' : 'single';
            if (!state.config.poolFinalFormats || typeof state.config.poolFinalFormats !== 'object') {
              state.config.poolFinalFormats = {};
            }
            state.config.poolFinalFormats[groupKey] = format;
            if (groupKey === 'A') state.config.poolAFinalFormat = format;
            if (groupKey === 'B') state.config.poolBFinalFormat = format;
            saveState();
          });
        });
        document.querySelectorAll('[data-set-leader]').forEach(btn => {
          btn.addEventListener('click', () => {
            const [gi, pi] = btn.getAttribute('data-set-leader').split(':').map(Number);
            state.groups[gi].leader = state.groups[gi].players[pi];
            saveState();
            render();
          });
        });
        document.querySelectorAll('[data-player-edit]').forEach(inp => {
          inp.addEventListener('change', () => {
            const [gi, pi] = inp.getAttribute('data-player-edit').split(':').map(Number);
            if (renamePlayerEverywhere(gi, pi, inp.value)) saveState();
            else inp.value = state.groups[gi].players[pi] || '';
          });
        });
        document.querySelectorAll('[data-remove-player]').forEach(btn => {
          btn.addEventListener('click', () => {
            const [gi, pi] = btn.getAttribute('data-remove-player').split(':').map(Number);
            const removed = state.groups[gi].players.splice(pi, 1)[0];
            if (state.groups[gi].leader === removed) state.groups[gi].leader = state.groups[gi].players[0] || '';
            saveState();
            render();
          });
        });
        document.querySelectorAll('[data-player-skill]').forEach(inp => {
          inp.addEventListener('change', () => {
            const [gi, pi] = inp.getAttribute('data-player-skill').split(':').map(Number);
            const name = state.groups[gi]?.players[pi];
            if (!name) return;
            setPlayerSkill(name, inp.value);
            saveState();
          });
        });
        document.querySelectorAll('[data-add-player-btn]').forEach(btn => {
          btn.addEventListener('click', () => {
            const gi = Number(btn.getAttribute('data-add-player-btn'));
            openGroupPlayerPicker(gi);
          });
        });
        document.getElementById('start-tournament-btn')?.addEventListener('click', startTournament);

        // QR1, QR2, Semis, Finals bindings
        document.getElementById('sim-qr1-btn')?.addEventListener('click', () => simulateMatches(state.qr1Matches));
        document.getElementById('advance-qr2-btn')?.addEventListener('click', advanceToQR2);
        document.getElementById('sim-qr2-btn')?.addEventListener('click', () => simulateMatches(Object.values(state.qr2Matches || {}).flat()));
        document.getElementById('advance-semis-btn')?.addEventListener('click', advanceToSemis);
        document.getElementById('sim-semis-btn')?.addEventListener('click', () => simulateMatches(Object.values(state.semis || {}).flat()));
        document.getElementById('advance-finals-btn')?.addEventListener('click', advanceToFinals);

        document.getElementById('add-qr2-pool-btn')?.addEventListener('click', () => {
          const existing = Object.keys(state.qr2Pools || {});
          const nextLetter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find(l => !existing.includes(l));
          if (!nextLetter) { showToast('Maximum group limit reached', 'error'); return; }
          openModal(`
            <div class="w-full max-w-md rounded-2xl bg-white dark:bg-[#191B1F] border border-stone-200 dark:border-stone-800 p-6 space-y-4">
              <h3 class="text-base font-bold">Add Round 2 Group ${nextLetter}</h3>
              <div class="space-y-3 text-xs">
                <div>
                  <label class="block font-semibold text-stone-500 mb-1">How to populate Group ${nextLetter}</label>
                  <select id="add-pool-mode" class="w-full px-3 py-2 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-sm">
                    <option value="rebalance">Rebalance lower-ranked players from existing groups</option>
                    <option value="custom">Enter custom player names</option>
                  </select>
                </div>
                <div id="custom-pool-players-wrap" class="hidden">
                  <label class="block font-semibold text-stone-500 mb-1">Players (one per line or comma-separated)</label>
                  <textarea id="custom-pool-players" rows="4" placeholder="Player 1&#10;Player 2&#10;Player 3" class="w-full p-2.5 rounded-lg bg-cream-50 dark:bg-[#111214] border border-stone-300 dark:border-stone-700 text-xs"></textarea>
                </div>
              </div>
              <div class="flex justify-end gap-2">
                <button id="modal-cancel" class="px-3 py-1.5 rounded-lg border border-stone-300 dark:border-stone-700 text-xs font-medium">Cancel</button>
                <button id="modal-add-pool-confirm" class="px-4 py-1.5 rounded-lg bg-gold-500 text-stone-950 text-xs font-bold">Create Group ${nextLetter}</button>
              </div>
            </div>
          `);
          document.getElementById('modal-cancel').addEventListener('click', closeModal);
          const modeSel = document.getElementById('add-pool-mode');
          const customWrap = document.getElementById('custom-pool-players-wrap');
          modeSel.addEventListener('change', () => {
            customWrap.classList.toggle('hidden', modeSel.value !== 'custom');
          });
          document.getElementById('modal-add-pool-confirm').addEventListener('click', () => {
            if (modeSel.value === 'custom') {
              const names = document.getElementById('custom-pool-players').value.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
              if (names.length < 4) { showToast('Enter at least 4 players', 'error'); return; }
              if (!addQR2Pool(nextLetter, names)) return;
              closeModal();
              showToast(`Added Group ${nextLetter} (${names.length} players)`, 'success');
            } else {
              const nonA = existing.filter(k => k !== 'A');
              const poolPlayers = nonA.flatMap(k => state.qr2Pools[k] || []);
              if (poolPlayers.length < 4) { showToast('Not enough players outside Group A to split', 'error'); return; }
              const newKeys = [...nonA, nextLetter];
              const chunk = Math.ceil(poolPlayers.length / newKeys.length);
              const newPools = {};
              newKeys.forEach((k, idx) => {
                newPools[k] = poolPlayers.slice(idx * chunk, (idx + 1) * chunk);
              });
              const newPlayers = newPools[nextLetter];
              delete newPools[nextLetter];
              if (!addQR2Pool(nextLetter, newPlayers, newPools)) return;
              closeModal();
              showToast(`Added Group ${nextLetter} and rebalanced ${newKeys.join(', ')}`, 'success');
            }
          });
        });

        document.querySelectorAll('[data-regen-pool]').forEach(btn => {
          btn.addEventListener('click', () => {
            const k = btn.getAttribute('data-regen-pool');
            const players = state.qr2Pools[k] || [];
            const duplicate = getDuplicateGroupPlayer(state.qr2Pools);
            if (duplicate !== null) {
              showToast(`Round 2: each player must appear in only one group (${duplicate})`, 'error');
              return;
            }
            const schedules = buildQR2Schedules({ [k]: players });
            if (!schedules) return;
            state.qr2Matches[k] = schedules[k];
            saveState();
            render();
            showToast(`Regenerated Group ${k} schedule`, 'success');
          });
        });

        document.querySelectorAll('[data-remove-pool]').forEach(btn => {
          btn.addEventListener('click', () => {
            const k = btn.getAttribute('data-remove-pool');
            delete state.qr2Pools[k];
            delete state.qr2Matches[k];
            saveState();
            render();
            showToast(`Removed Group ${k}`, 'success');
          });
        });

        document.querySelectorAll('[data-save-match]').forEach(btn => {
          btn.addEventListener('click', () => {
            const [listKey, id] = btn.getAttribute('data-save-match').split(':');
            const s1El = document.querySelector(`[data-score-input="${listKey}:${id}:1"]`);
            const s2El = document.querySelector(`[data-score-input="${listKey}:${id}:2"]`);
            const s1 = parseInt(s1El.value, 10);
            const s2 = parseInt(s2El.value, 10);
            if (!isValidSingleScore(s1, s2, state.config.pointsToWin, state.config.deuceCap)) {
              showToast(`Invalid score (game to ${state.config.pointsToWin}, cap ${state.config.deuceCap}, win by 2)`, 'error');
              return;
            }
            let m = null;
            if (listKey === 'qr1') m = state.qr1Matches.find(x => x.id === id);
            else if (listKey.startsWith('qr2_')) m = (state.qr2Matches[listKey.slice(4)] || []).find(x => x.id === id);
            else if (listKey.startsWith('semi_')) m = (state.semis[listKey.slice(5)] || []).find(x => x.id === id);
            if (!m) {
              showToast('Match no longer exists; refresh the schedule', 'error');
              return;
            }
            const expectedMatch = JSON.parse(JSON.stringify(m));
            const save = async confirmedRevision => {
              if (getSyncApiUrl()) {
                if (await saveMatchScore(listKey, id, expectedMatch, { s1, s2 }, confirmedRevision)) {
                  showToast('Score saved', 'success');
                }
                return;
              }
              m.s1 = s1; m.s2 = s2; m.completed = true; m.completedAt = new Date().toISOString();
              saveState();
              render();
              showToast('Score saved', 'success');
            };
            if (m.completed && m.s1 === s1 && m.s2 === s2) {
              showToast('Score is unchanged');
              return;
            }
            const tournamentId = state.tournamentId;
            const isCurrent = () => {
              if (state.tournamentId !== tournamentId) return false;
              if (listKey === 'qr1') return state.qr1Matches.includes(m);
              if (listKey.startsWith('qr2_')) return (state.qr2Matches[listKey.slice(4)] || []).includes(m);
              return (state.semis[listKey.slice(5)] || []).includes(m);
            };
            confirmScoreCorrection(listKey, save, isCurrent);
          });
        });

        document.getElementById('complete-tournament-btn')?.addEventListener('click', () => {
          if (state.auth.role !== 'admin') return;
          if (hasUnsavedScoreEntry()) {
            showToast('Save or discard score changes before marking the tournament done', 'error');
            return;
          }
          if (!TournamentDraw.isTournamentReadyToComplete(state)) {
            showToast('Complete all tournament matches before marking it done', 'error');
            return;
          }
          state.phase = 'completed';
          saveState();
          render();
          showToast('Tournament marked done', 'success');
        });

        document.querySelectorAll('[data-save-final]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const poolKey = btn.getAttribute('data-save-final');
            const f = state.finals[poolKey];
            const expectedMatch = JSON.parse(JSON.stringify(f));
            const games = [];
            let t1Wins = 0, t2Wins = 0;
            for (let gi = 0; gi < f.games.length; gi++) {
              const v1 = document.querySelector(`[data-final-input="${poolKey}:${gi}:1"]`).value;
              const v2 = document.querySelector(`[data-final-input="${poolKey}:${gi}:2"]`).value;
              if (v1 === '' && v2 === '') {
                games.push({ s1: null, s2: null });
                continue;
              }
              const s1 = parseInt(v1, 10), s2 = parseInt(v2, 10);
              if (!isValidSingleScore(s1, s2, state.config.pointsToWin, state.config.deuceCap)) {
                showToast(`Invalid score in Game ${gi + 1}`, 'error');
                return;
              }
              games.push({ s1, s2 });
              if (s1 > s2) t1Wins++; else t2Wins++;
            }
            if (getSyncApiUrl()) {
              if (await saveMatchScore(`final_${poolKey}`, f.id || poolKey, expectedMatch, { games }, null)) {
                const savedFinal = state.finals[poolKey];
                showToast(savedFinal.completed ? `Group ${poolKey} Champion: ${savedFinal.winner}!` : 'Final game scores saved', 'success');
              }
              return;
            }
            const needed = f.format === 'bo3' ? 2 : 1;
            if (state.phase === 'completed' && t1Wins < needed && t2Wins < needed &&
                getLocalTournamentCatalog().some(tournament => tournament.id !== String(state.tournamentId) && tournament.phase !== 'completed')) {
              showToast('Close or delete the open tournament before reopening this tournament', 'error');
              return;
            }
            f.games = games;
            if (t1Wins >= needed || t2Wins >= needed) {
              f.completed = true;
              f.winner = t1Wins > t2Wins ? f.t1 : f.t2;
              f.completedAt = new Date().toISOString();
              showToast(`Group ${poolKey} Champion: ${f.winner}!`, 'success');
            } else {
              f.completed = false;
              f.winner = null;
              if (state.phase === 'completed') {
                state.phase = 'finals';
                delete state.closedEarly;
              }
              delete f.completedAt;
              showToast('Final game scores saved', 'success');
            }
            saveState();
            render();
          });
        });
      }

      window.addEventListener('storage', event => {
        if (event.key === REGISTRY_KEY && event.newValue) {
          try {
            const latestRegistry = JSON.parse(event.newValue);
            registry = latestRegistry;
            const latestTournament = latestRegistry.items?.[state.tournamentId];
            const localEditsPending = ['pending', 'syncing', 'error'].includes(state.sync?.status) ||
              ['pending', 'syncing'].includes(latestTournament?.sync?.status);
            if (latestTournament && !localEditsPending && !scoreSaveInProgress && !checkInSaveInProgress &&
                !isEditingFormField() && !hasUnsavedScoreEntry()) {
              const currentUi = state.ui;
              state = normalizeTournamentState({
                ...latestTournament,
                auth: state.auth,
                sync: { ...state.sync, ...(latestTournament.sync || {}) },
                ui: { ...(latestTournament.ui || {}), ...currentUi }
              }, state.tournamentId);
              upsertPlayerDataTournament(state.tournamentId, state, state.sync.lastSynced);
              render();
            }
          } catch (err) {
            console.error('Could not refresh player match history from another tab:', err);
          }
        } else if (event.key === PLAYER_PROFILES_KEY && event.newValue && !getSyncApiUrl()) {
          try {
            const profiles = JSON.parse(event.newValue);
            if (!Array.isArray(profiles)) throw new Error('Stored profiles are not a list');
            playerData.profiles = playerAccountProfile
              ? [...profiles.filter(profile => !samePlayerIdentity(profile, playerAccountProfile)), playerAccountProfile]
              : profiles;
            if (state.ui.activeTab === 'players') render();
          } catch (err) {
            console.error('Could not refresh player profiles from another tab:', err);
          }
        }
      });

      async function refreshPlayerDirectory() {
        if (document.visibilityState === 'hidden' || !state.auth.loggedIn || state.ui.playerCheckInMode ||
            state.ui.activeTab !== 'players' ||
            !getSyncApiUrl() || playerData.loading || isEditingFormField() ||
            !document.getElementById('modal-root').classList.contains('hidden')) return null;
        const before = JSON.stringify([playerData.tournaments, playerData.profiles, playerData.error]);
        await loadPlayerData(true);
        if (state.ui.activeTab === 'players' &&
            before !== JSON.stringify([playerData.tournaments, playerData.profiles, playerData.error])) render();
        return !playerData.error;
      }

      let changePollingStarted = false;
      let changePollTimer = null;
      let changePollInFlight = false;
      let forceChangePollQueued = false;
      let changePollFailures = 0;
      let changePollErrorLogged = false;
      let changePollApi = '';
      let seenTournamentId = '';
      let seenTournamentVersion = null;
      let seenCatalogVersion = null;
      let seenPlayerVersions = null;
      let nextScoreCheck = 0;
      let nextCatalogCheck = 0;
      let nextPlayerCheck = 0;

      function scheduleChangeRefresh() {
        if (!changePollingStarted || !state.auth.loggedIn || !getSyncApiUrl()) return;
        if (changePollInFlight) {
          forceChangePollQueued = true;
          return;
        }
        clearTimeout(changePollTimer);
        changePollTimer = setTimeout(() => pollChanges(true), 0);
      }

      async function pollChanges(force = false) {
        if (changePollInFlight) {
          if (force) forceChangePollQueued = true;
          return;
        }
        changePollInFlight = true;
        let failed = false;
        try {
          const apiUrl = getSyncApiUrl();
          if (!apiUrl || !state.auth.loggedIn || document.visibilityState === 'hidden') return;
          const tournamentId = String(state.tournamentId || 'default');
          if (changePollApi !== apiUrl) {
            changePollApi = apiUrl;
            seenTournamentId = '';
            seenCatalogVersion = null;
            seenPlayerVersions = null;
          }
          if (seenTournamentId !== tournamentId) {
            seenTournamentId = tournamentId;
            seenTournamentVersion = null;
          }
          const fresh = force ? `?fresh=${Date.now()}` : '';
          const response = await fetch(`${apiUrl}/api/changes/${encodeURIComponent(tournamentId)}${fresh}`,
            force ? { cache: 'no-store' } : {});
          const versions = await response.json();
          if (!response.ok) throw new Error(versions.error || `Change check failed (HTTP ${response.status})`);
          if (!['tournament', 'tournaments', 'profiles'].every(key => Number.isSafeInteger(versions[key]) && versions[key] >= 0)) {
            throw new Error('Invalid change versions from backend');
          }
          if (getSyncApiUrl() !== apiUrl || String(state.tournamentId || 'default') !== tournamentId || !state.auth.loggedIn) return;
          const now = Date.now();
          if (force || now >= nextScoreCheck) {
            nextScoreCheck = now + 5000;
            if (seenTournamentVersion !== versions.tournament) {
              const refreshed = await refreshLiveScores();
              if (refreshed === true) seenTournamentVersion = versions.tournament;
              if (refreshed === false) failed = true;
            }
          }
          if (force || now >= nextCatalogCheck) {
            nextCatalogCheck = now + 15000;
            if (seenCatalogVersion !== versions.tournaments) {
              const refreshed = await refreshTournamentList();
              if (refreshed === true) seenCatalogVersion = versions.tournaments;
              if (refreshed === false) failed = true;
            }
          }
          if (force || now >= nextPlayerCheck) {
            nextPlayerCheck = now + 30000;
            const playerVersions = `${versions.tournaments}:${versions.profiles}`;
            if (state.ui.activeTab === 'players' && seenPlayerVersions !== playerVersions) {
              const refreshed = await refreshPlayerDirectory();
              if (refreshed === true) seenPlayerVersions = playerVersions;
              if (refreshed === false) failed = true;
            }
          }
          if (!failed) {
            changePollFailures = 0;
            changePollErrorLogged = false;
          }
        } catch (err) {
          failed = true;
          if (!changePollErrorLogged) {
            console.error('Live update check failed:', err);
            showToast(`Live updates could not be checked: ${err.message}`, 'error');
            changePollErrorLogged = true;
          }
        } finally {
          changePollInFlight = false;
          if (failed) changePollFailures += 1;
          const delay = failed
            ? Math.round(Math.min(60000, 5000 * (2 ** Math.min(changePollFailures, 4))) * (0.8 + Math.random() * 0.4))
            : 5000;
          clearTimeout(changePollTimer);
          if (forceChangePollQueued && document.visibilityState === 'visible') {
            forceChangePollQueued = false;
            changePollTimer = setTimeout(() => pollChanges(true), failed ? delay : 0);
          } else {
            forceChangePollQueued = false;
            changePollTimer = setTimeout(pollChanges, delay);
          }
        }
      }

      window.addEventListener('focus', scheduleChangeRefresh);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') scheduleChangeRefresh();
      });

      (async () => {
        if (playerInviteToken) {
          await loadPlayerInvite();
        } else if (usesAdminSession() && (state.auth.role === 'admin' || !state.auth.loggedIn)) {
          try {
            await requestAdminSession('/api/admin-auth/me');
            state.auth.loggedIn = true;
            state.auth.role = 'admin';
            Object.values(registry.items).forEach(tournament => {
              if (tournament.sync) tournament.sync.syncKey = '';
            });
            state.sync.syncKey = '';
            saveRegistry();
          } catch (err) {
            if (state.auth.role === 'admin') {
              state.auth.loggedIn = false;
              state.auth.role = 'guest';
              saveRegistry();
            }
            if (err.status !== 401) {
              console.error('Could not restore admin session:', err);
              adminAuthError = `Admin session could not be restored: ${err.message}`;
            }
            if (!state.auth.loggedIn) await restorePlayerSession();
          }
        } else if (state.auth.role === 'player' || !state.auth.loggedIn) {
          await restorePlayerSession();
        }
        if (state.auth.loggedIn && state.auth.role === 'admin' && !usesAdminSession()) {
          if (Number(state.auth.localExpiresAt || 0) <= Date.now()) expireSession();
          else setSessionExpiry(new Date(state.auth.localExpiresAt).toISOString());
        }
        if (state.auth.loggedIn && state.auth.role === 'guest' && state.ui.activeTab !== getRequestedPage()) {
          window.location.replace(getPageUrl(state.ui.activeTab));
          return;
        }
        render();
        if (getSyncApiUrl()) {
          await pullFromTurso(true);
        }
        changePollingStarted = true;
        changePollTimer = setTimeout(pollChanges, 5000);
        scheduleChangeRefresh();
      })();
    })();