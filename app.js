/*
    consortium_screens - html/app.js
    Lecteur embarque dans le DUI. Lit les parametres passes en query string
    par le client Lua (client/dui.lua -> BuildPlayerUrl) et affiche le
    contenu correspondant (YouTube / Twitch / Vimeo / MP4 / HLS / Image /
    HTML / Radio), avec synchronisation temporelle basee sur l'horloge
    serveur et reception du volume spatial via SendDuiMessage.
*/

(function () {
    'use strict';

    var qs = new URLSearchParams(window.location.search);

    var params = {
        uuid: qs.get('uuid') || '',
        type: qs.get('type') || 'html',
        src: qs.get('src') || '',
        volume: parseInt(qs.get('volume') || '0', 10),
        loop: qs.get('loop') === '1',
        autoplay: qs.get('autoplay') === '1',
        startedAt: parseInt(qs.get('startedAt') || '0', 10),
        paused: qs.get('paused') === '1',
        pausedAt: parseInt(qs.get('pausedAt') || '0', 10),
        serverTime: parseInt(qs.get('serverTime') || '0', 10),
    };

    // Offset entre l'horloge serveur (au moment de la generation de l'URL)
    // et l'horloge locale du navigateur DUI, pour calculer le temps de
    // lecture ecoule de facon coherente entre tous les joueurs.
    var clockOffset = params.serverTime > 0 ? (params.serverTime - Date.now()) : 0;

    var loadingEl = document.getElementById('loading');
    var errorEl = document.getElementById('error');
    var errorReasonEl = document.getElementById('error-reason');
    var root = document.getElementById('content-root');

    var mediaElement = null; // <video> ou <audio> actif, pour le controle direct du volume
    var ytPlayer = null; // objet YT.Player reel (API officielle YouTube)
    var vimeoPlayer = null; // objet Vimeo.Player reel (SDK officiel), declare pres de son usage
    var twitchPlayer = null;

    // ============================================================
    // RELAIS DE DEBUG VERS LA CONSOLE F8 (cote client Lua)
    // ============================================================
    // Le DUI n'a pas de console visible en jeu : sans ca, impossible de
    // savoir POURQUOI un contenu echoue (erreur reseau ? video privee ?
    // embed desactive ? parametre invalide ?). On relaie chaque erreur
    // vers client/main.lua (voir consortium_screens_debug_report), qui
    // l'affiche en F8 si Config.Debug est actif.
    function reportDebug(message) {
        try {
            var resourceName = window.location.hostname || 'consortium_screens';
            // IMPORTANT : FiveM exige le prefixe "cfx-nui-" sur le host pour
            // qu'une requete fetch() soit interceptee comme callback NUI.
            fetch('https://cfx-nui-' + resourceName + '/consortium_screens_debug_report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ uuid: params.uuid, type: params.type, message: String(message) }),
            }).catch(function () { /* relais best-effort, ignore si indisponible */ });
        } catch (e) { /* ignore */ }
    }

    // Capture aussi les erreurs JS non prevues (bug de script, typo, etc.)
    window.addEventListener('error', function (e) {
        reportDebug('JS error: ' + (e && e.message ? e.message : 'inconnue') + ' (' + (e && e.filename ? e.filename : '') + ':' + (e && e.lineno) + ')');
    });

    function showLoading(state) {
        loadingEl.classList.toggle('hidden', !state);
    }

    function showError(state, reason) {
        errorEl.classList.toggle('hidden', !state);
        // Une erreur doit toujours masquer le spinner de chargement, quel
        // que soit le point d'appel (evite les deux overlays superposes).
        if (state) {
            loadingEl.classList.add('hidden');
            // Affiche la raison directement sur l'ecran en jeu : c'est le
            // canal de diagnostic le plus fiable (visible sans devoir
            // compter sur le relais F8, qui depend d'un callback NUI).
            if (errorReasonEl) {
                errorReasonEl.textContent = reason || '';
            }
            reportDebug('Erreur affichee: ' + (reason || 'raison inconnue') + ' | type=' + params.type + ' | src=' + params.src);
        }
    }

    function getElapsedSeconds() {
        if (!params.startedAt) return 0;
        var now = Date.now() + clockOffset;
        var reference = params.paused ? params.pausedAt : now;
        var elapsedMs = reference - params.startedAt;
        return Math.max(0, elapsedMs / 1000);
    }

    // ============================================================
    // Extraction d'identifiants depuis des URLs completes
    // ============================================================
    function extractYoutubeId(url) {
        var match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/);
        if (match) return match[1];
        // Peut-etre deja un ID brut
        if (/^[A-Za-z0-9_-]{6,}$/.test(url.trim())) return url.trim();
        return null;
    }

    function extractTwitchChannel(url) {
        var match = url.match(/twitch\.tv\/([A-Za-z0-9_]+)/);
        if (match) return match[1];
        return url.trim();
    }

    function extractVimeoId(url) {
        var match = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
        if (match) return match[1];
        if (/^\d+$/.test(url.trim())) return url.trim();
        return null;
    }

    // ============================================================
    // RENDU PAR TYPE DE CONTENU
    // ============================================================
    function loadYoutubeIframeApi(callback) {
        if (window.YT && window.YT.Player) {
            callback();
            return;
        }
        if (window.__ytApiLoading) {
            // Deja en cours de chargement (ne devrait pas arriver ici car un
            // seul lecteur par page), on attend juste le callback global.
            var prevReady = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = function () {
                if (prevReady) prevReady();
                callback();
            };
            return;
        }
        window.__ytApiLoading = true;
        window.onYouTubeIframeAPIReady = callback;
        var tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.onerror = function () { showError(true, 'echec chargement script https://www.youtube.com/iframe_api (reseau/DNS/bloque)'); };
        document.head.appendChild(tag);
    }

    // Codes d'erreur officiels de l'API YouTube IFrame
    var YT_ERROR_CODES = {
        2: 'parametre invalide (ID video incorrect)',
        5: 'erreur lecteur HTML5',
        100: 'video introuvable ou supprimee',
        101: 'le proprietaire de la video interdit la lecture embarquee (embed)',
        150: 'le proprietaire de la video interdit la lecture embarquee (embed)',
        153: 'en-tete Referer manquant ou non reconnu par YouTube (voir meta referrer dans index.html)',
    };

    function renderYoutube() {
        var videoId = extractYoutubeId(params.src);
        if (!videoId) return showError(true, 'URL YouTube non reconnue par extractYoutubeId(): "' + params.src + '"');

        var container = document.createElement('div');
        container.id = 'yt-player-target';
        root.appendChild(container);

        loadYoutubeIframeApi(function () {
            var start = Math.floor(getElapsedSeconds());

            var playerVars = {
                autoplay: params.autoplay ? 1 : 0,
                // IMPORTANT : les navigateurs bases sur Chromium (dont le CEF
                // utilise par le DUI FiveM) bloquent systematiquement
                // l'autoplay AVEC son en l'absence d'interaction utilisateur.
                // On demarre donc toujours mute, puis on desactive le mute
                // et on applique le volume dans onReady/onStateChange via
                // l'objet YT.Player reel (pas de postMessage manuel).
                mute: 1,
                controls: 0,
                modestbranding: 1,
                rel: 0,
                start: start,
                playsinline: 1,
            };

            if (params.loop) {
                playerVars.loop = 1;
                playerVars.playlist = videoId; // requis par YouTube pour boucler une seule video
            }

            reportDebug('Creation YT.Player, videoId=' + videoId + ', start=' + start);

            ytPlayer = new window.YT.Player('yt-player-target', {
                videoId: videoId,
                width: '100%',
                height: '100%',
                playerVars: playerVars,
                events: {
                    onReady: function (e) {
                        reportDebug('YT.Player onReady OK pour videoId=' + videoId);
                        showLoading(false);

                        // IMPORTANT : demarrer la lecture PENDANT que le
                        // lecteur est encore mute, puis desactiver le mute
                        // apres coup. Faire l'inverse (unMute avant
                        // playVideo) redeclenche le blocage autoplay du
                        // navigateur, car playVideo() est alors appele sur
                        // un lecteur deja non-mute.
                        if (params.paused) {
                            e.target.pauseVideo();
                        } else if (params.autoplay) {
                            e.target.playVideo();
                        }

                        setTimeout(function () {
                            e.target.setVolume(Math.max(0, Math.min(100, params.volume || 0)));
                            e.target.unMute();
                        }, 300);
                    },
                    onError: function (e) {
                        var code = e && e.data;
                        var reason = YT_ERROR_CODES[code] || ('code inconnu: ' + code);

                        if (code === 153) {
                            reason += ' - solution: heberger le lecteur sur une URL https externe via Config.PlayerBaseUrl (voir README, section "YouTube ne fonctionne pas / erreur 153")';
                        }

                        showError(true, 'YT.Player onError - ' + reason + ' (videoId=' + videoId + ')');
                    },
                },
            });
        });
    }


    function renderTwitch() {
        var channel = extractTwitchChannel(params.src);
        if (!channel) return showError(true, 'chaine Twitch non reconnue: "' + params.src + '"');

        var script = document.createElement('script');
        script.src = 'https://player.twitch.tv/js/embed/v1.js';
        script.onload = function () {
            try {
                var readyFired = false;

                twitchPlayer = new Twitch.Player('content-root', {
                    channel: channel,
                    width: '100%',
                    height: '100%',
                    autoplay: params.autoplay,
                    // Demarre muet pour contourner le blocage autoplay
                    // Chromium, puis desactive le mute une fois pret.
                    muted: true,
                    parent: ['nui-game-internal', 'cfx.re', 'localhost'],
                });
                twitchPlayer.addEventListener(Twitch.Player.READY, function () {
                    readyFired = true;
                    showLoading(false);
                    twitchPlayer.setVolume((params.volume || 0) / 100);
                    twitchPlayer.setMuted(false);
                });

                // Twitch rejette silencieusement l'iframe si le domaine
                // "parent" n'est pas reconnu (ni exception JS, ni evenement
                // d'erreur declenche) : sans ce timeout, l'ecran reste
                // bloque en chargement indefiniment sans aucun diagnostic.
                setTimeout(function () {
                    if (!readyFired) {
                        showError(true, 'Twitch.Player READY jamais recu apres 8s - probable rejet du parametre "parent" (domaine nui-game-internal non reconnu par Twitch) ou chaine "' + channel + '" invalide.');
                    }
                }, 8000);
            } catch (e) {
                showError(true, 'exception Twitch.Player: ' + e.message);
            }
        };
        script.onerror = function () { showError(true, 'echec chargement player.twitch.tv/js/embed/v1.js'); };
        document.head.appendChild(script);
    }

    function loadVimeoSdk(callback) {
        if (window.Vimeo && window.Vimeo.Player) {
            callback();
            return;
        }
        var script = document.createElement('script');
        script.src = 'https://player.vimeo.com/api/player.js';
        script.onload = callback;
        script.onerror = function () { showError(true, 'ID/URL Vimeo invalide: "' + params.src + '"'); };
        document.head.appendChild(script);
    }

    function renderVimeo() {
        var videoId = extractVimeoId(params.src);
        if (!videoId) return showError(true, 'URL Vimeo non reconnue: "' + params.src + '"');

        var container = document.createElement('div');
        container.id = 'vimeo-player-target';
        root.appendChild(container);

        loadVimeoSdk(function () {
            vimeoPlayer = new window.Vimeo.Player('vimeo-player-target', {
                id: videoId,
                autopause: false,
                autoplay: params.autoplay,
                loop: params.loop,
                muted: true, // demarre mute (politique autoplay), desactive une fois pret
                controls: false,
                background: false,
                width: undefined,
                responsive: true,
            });

            vimeoPlayer.ready().then(function () {
                showLoading(false);
                var elapsed = getElapsedSeconds();
                return vimeoPlayer.setCurrentTime(elapsed).catch(function () {});
            }).then(function () {
                vimeoPlayer.setVolume(Math.max(0, Math.min(1, (params.volume || 0) / 100))).catch(function () {});
                vimeoPlayer.setMuted(false).catch(function () {});
                if (params.paused) {
                    vimeoPlayer.pause().catch(function () {});
                } else if (params.autoplay) {
                    vimeoPlayer.play().catch(function () {});
                }
            }).catch(function () {
                showError(true, 'exception Vimeo.Player (voir promesse rejetee)');
            });
        });
    }

    function renderVideoLike() {
        var video = document.createElement('video');
        video.src = params.src;
        video.autoplay = params.autoplay;
        video.loop = params.loop;
        // Demarre muet (contourne le blocage autoplay-avec-son de Chromium),
        // le son est reactive juste apres le debut de la lecture.
        video.muted = true;
        video.volume = Math.max(0, Math.min(1, (params.volume || 0) / 100));
        video.playsInline = true;

        video.addEventListener('loadedmetadata', function () {
            var elapsed = getElapsedSeconds();
            if (isFinite(video.duration) && video.duration > 0) {
                video.currentTime = params.loop ? (elapsed % video.duration) : Math.min(elapsed, video.duration);
            } else {
                video.currentTime = elapsed;
            }
            showLoading(false);
            if (params.autoplay && !params.paused) {
                video.play().then(function () {
                    unmuteMediaElement(video);
                }).catch(function () {
                    // Autoplay refuse malgre le mute (rare) : on retentera au
                    // premier geste utilisateur via le listener ci-dessous.
                    var retry = function () {
                        video.play().then(function () { unmuteMediaElement(video); });
                        document.removeEventListener('click', retry);
                    };
                    document.addEventListener('click', retry);
                });
            } else {
                unmuteMediaElement(video);
            }
            if (params.paused) video.pause();
        });

        video.addEventListener('error', function () {
            var mediaError = video.error;
            var codes = { 1: 'ABORTED (charge annule)', 2: 'NETWORK (erreur reseau)', 3: 'DECODE (format/codec illisible)', 4: 'SRC_NOT_SUPPORTED (format non supporte ou URL invalide)' };
            var detail = mediaError ? (codes[mediaError.code] || ('code ' + mediaError.code)) + (mediaError.message ? ' - ' + mediaError.message : '') : 'inconnue';
            showError(true, 'erreur video MP4 [' + detail + ']: ' + params.src);
        });

        root.appendChild(video);
        mediaElement = video;
    }

    function unmuteMediaElement(el) {
        // Court delai avant de retirer le mute : sur certains moteurs CEF,
        // desactiver le mute dans le meme tick que play() peut re-declencher
        // le blocage autoplay. 150ms est suffisant et imperceptible.
        setTimeout(function () {
            el.muted = false;
            el.volume = Math.max(0, Math.min(1, (params.volume || 0) / 100));
        }, 150);
    }

    function renderHls() {
        var video = document.createElement('video');
        video.autoplay = params.autoplay;
        video.muted = true;
        video.volume = Math.max(0, Math.min(1, (params.volume || 0) / 100));
        video.playsInline = true;
        root.appendChild(video);
        mediaElement = video;

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Support HLS natif (rare hors Safari/WebKit)
            video.src = params.src;
            video.addEventListener('loadedmetadata', function () {
                showLoading(false);
                if (params.autoplay) {
                    video.play().then(function () { unmuteMediaElement(video); }).catch(function () {});
                } else {
                    unmuteMediaElement(video);
                }
            });
            video.addEventListener('error', function () {
                var mediaError = video.error;
                var codes = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
                var detail = mediaError ? (codes[mediaError.code] || ('code ' + mediaError.code)) : 'inconnue';
                showError(true, 'erreur HLS natif [' + detail + ']: ' + params.src);
            });
            return;
        }

        var script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js';
        script.onload = function () {
            if (window.Hls && window.Hls.isSupported()) {
                var hls = new window.Hls();
                hls.loadSource(params.src);
                hls.attachMedia(video);
                hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
                    showLoading(false);
                    if (params.autoplay) {
                        video.play().then(function () { unmuteMediaElement(video); }).catch(function () {});
                    } else {
                        unmuteMediaElement(video);
                    }
                });
                hls.on(window.Hls.Events.ERROR, function (event, data) {
                    if (data.fatal) showError(true, 'erreur fatale hls.js: ' + (data.type || 'inconnue'));
                });
            } else {
                showError(true, 'hls.js charge mais Hls.isSupported() = false');
            }
        };
        script.onerror = function () { showError(true, 'echec chargement cdnjs hls.min.js'); };
        document.head.appendChild(script);
    }

    function renderImage() {
        var img = document.createElement('img');
        img.src = params.src;
        img.addEventListener('load', function () { showLoading(false); });
        img.addEventListener('error', function () { showError(true, 'erreur chargement image: ' + params.src); });
        root.appendChild(img);
    }

    function renderHtml() {
        var iframe = document.createElement('iframe');
        iframe.src = params.src;
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
        iframe.addEventListener('load', function () { showLoading(false); });
        iframe.addEventListener('error', function () { showError(true, 'erreur chargement page HTML: ' + params.src); });
        root.appendChild(iframe);
    }

    function renderRadio() {
        var audio = document.createElement('audio');
        audio.src = params.src;
        audio.autoplay = params.autoplay;
        audio.loop = params.loop;
        audio.muted = true;
        audio.volume = Math.max(0, Math.min(1, (params.volume || 0) / 100));
        audio.addEventListener('loadedmetadata', function () {
            showLoading(false);
            if (params.autoplay) {
                audio.play().then(function () { unmuteMediaElement(audio); }).catch(function () {});
            } else {
                unmuteMediaElement(audio);
            }
        });
        audio.addEventListener('error', function () { showError(true, 'erreur chargement radio: ' + params.src); });
        root.appendChild(audio);
        mediaElement = audio;
    }

    // ============================================================
    // VOLUME SPATIAL (recu depuis client/main.lua via SendDuiMessage)
    // ============================================================
    window.addEventListener('message', function (event) {
        var data = event.data;
        if (!data) return;

        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) { return; }
        }

        if (data.action === 'setVolume') {
            var vol = Math.max(0, Math.min(100, data.volume || 0));
            params.volume = vol;

            if (mediaElement) {
                mediaElement.volume = vol / 100;
            }
            if (ytPlayer && ytPlayer.setVolume) {
                ytPlayer.setVolume(vol);
            }
            if (vimeoPlayer && vimeoPlayer.setVolume) {
                vimeoPlayer.setVolume(vol / 100).catch(function () {});
            }
            if (twitchPlayer && twitchPlayer.setVolume) {
                twitchPlayer.setVolume(vol / 100);
            }
        }
    });

    // ============================================================
    // INITIALISATION
    // ============================================================
    function init() {
        if (!params.src && params.type !== 'radio') {
            showLoading(false);
            showError(true, 'aucune source (src) fournie pour le type: ' + params.type);
            return;
        }

        switch (params.type) {
            case 'youtube': renderYoutube(); break;
            case 'twitch': renderTwitch(); break;
            case 'vimeo': renderVimeo(); break;
            case 'mp4': renderVideoLike(); break;
            case 'hls': renderHls(); break;
            case 'image': renderImage(); break;
            case 'html': renderHtml(); break;
            case 'radio': renderRadio(); break;
            default: showError(true, 'type de contenu inconnu: "' + params.type + '"');
        }
    }

    init();
})();
