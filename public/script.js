(function () {
  'use strict';

  const serverUrl = window.SERVER_URL || '';
  const socket = serverUrl ? io(serverUrl) : io();
  let iceServers = null;
  let localStream = null;
  let peerConnection = null;
  let dataChannel = null;
  let currentPeerId = null;
  let isInitiator = false;
  let isMicMuted = false;
  let isCamOff = false;
  let isSearching = false;
  let sessionStart = null;
  let timerInterval = null;

  const $ = (sel) => document.querySelector(sel);

  /* ── DOM refs ── */
  const statusDot = $('#status-dot');
  const statusText = $('#status-text');
  const homeScreen = $('#home-screen');
  const callScreen = $('#call-screen');
  const localPreview = $('#local-preview');
  const localVideo = $('#local-video');
  const remoteVideo = $('#remote-video');
  const remoteFallback = $('#remote-fallback');
  const startBtn = $('#start-btn');
  const nextBtn = $('#next-btn');
  const stopBtn = $('#stop-btn');
  const micBtn = $('#mic-btn');
  const camBtn = $('#cam-btn');
  const reportBtn = $('#report-btn');
  const chatMessages = $('#chat-messages');
  const chatInput = $('#chat-input');
  const chatSendBtn = $('#chat-send-btn');
  const reportModal = $('#report-modal');
  const reportReason = $('#report-reason');
  const reportCancel = $('#report-cancel');
  const reportSubmit = $('#report-submit');
  const modalClose = $('#modal-close');
  const connDot = document.querySelector('.conn-dot');
  const connLabel = document.querySelector('.conn-label');
  const connTimer = $('#conn-timer');

  /* ── Status helpers ── */

  function setStatus(text, state) {
    statusText.textContent = text;
    statusDot.className = 'dot';
    if (state === 'active') {
      statusDot.classList.add('active');
      statusText.style.color = '';
    } else if (state === 'connecting') {
      statusDot.classList.add('connecting');
      statusText.style.color = '';
    } else if (state === 'error') {
      statusDot.classList.add('error');
      statusText.style.color = '';
    } else {
      statusText.style.color = '';
    }
  }

  function setConnIndicator(text, state) {
    if (!connDot || !connLabel) return;
    connLabel.textContent = text;
    connDot.className = 'conn-dot';
    if (state === 'active') connDot.classList.add('active');
    else if (state === 'error') connDot.classList.add('error');
  }

  function startTimer() {
    sessionStart = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!sessionStart) return;
      const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      connTimer.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    sessionStart = null;
    connTimer.textContent = '00:00';
  }

  /* ── Init ── */

  async function init() {
    if (window.SERVER_CONFIG) {
      iceServers = { iceServers: window.SERVER_CONFIG.iceServers };
    } else {
      try {
        const base = serverUrl || '';
        const res = await fetch(base + '/ice-servers');
        iceServers = await res.json();
      } catch {
        iceServers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
      }
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localPreview.srcObject = localStream;
      localVideo.srcObject = localStream;
      startBtn.disabled = false;
    } catch {
      setStatus('camera / mic denied', 'error');
      startBtn.disabled = true;
    }

    setupSocket();
    setupUI();
    initParticles();
  }

  /* ── Particles ── */

  function initParticles() {
    const canvas = document.getElementById('particles');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h, particles = [];

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    const COUNT = 60;
    for (let i = 0; i < COUNT; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        r: Math.random() * 1.2 + 0.3,
        a: Math.random() * 0.4 + 0.1,
      });
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0, 229, 255, ${p.a})`;
        ctx.fill();
      }
      requestAnimationFrame(draw);
    }
    draw();
  }

  /* ── Socket events ── */

  function setupSocket() {
    socket.on('waiting', () => {
      setStatus('searching…', 'active');
      setConnIndicator('searching', 'active');
      isSearching = true;
    });

    socket.on('matched', async ({ roomId, initiator, peerId }) => {
      isSearching = false;
      currentPeerId = peerId;
      isInitiator = initiator;
      setStatus('connecting…', 'connecting');
      setConnIndicator('connecting', 'active');
      hideHome();
      showCall();
      await startPeerConnection(initiator);
    });

    socket.on('signal', async ({ from, data }) => {
      if (from !== currentPeerId) return;
      await handleSignal(data);
    });

    socket.on('peer-disconnected', ({ reason }) => {
      cleanupCall();
      stopTimer();
      if (reason === 'next') {
        setStatus('stranger left — searching…', 'active');
        setConnIndicator('reconnecting', 'active');
        socket.emit('find-match');
      } else {
        setStatus('stranger disconnected', 'error');
        setConnIndicator('disconnected', 'error');
      }
    });

    socket.on('stopped', () => {
      cleanupCall();
      stopTimer();
      showHome();
      setStatus('standby');
      setConnIndicator('disconnected');
    });

    socket.on('chat-message', ({ from, text }) => {
      if (from === currentPeerId) appendChatMessage(text, 'other');
    });

    socket.on('typing', ({ from }) => {
      if (from === currentPeerId) showTyping();
    });

    socket.on('stop-typing', ({ from }) => {
      if (from === currentPeerId) hideTyping();
    });
  }

  /* ── UI events ── */

  function setupUI() {
    startBtn.addEventListener('click', () => {
      if (!localStream) return;
      startBtn.disabled = true;
      setStatus('searching…', 'active');
      setConnIndicator('searching', 'active');
      socket.emit('find-match');
    });

    nextBtn.addEventListener('click', () => {
      cleanupPeerConnection();
      stopTimer();
      setStatus('searching…', 'active');
      setConnIndicator('searching', 'active');
      socket.emit('next');
    });

    stopBtn.addEventListener('click', () => {
      cleanupPeerConnection();
      stopTimer();
      socket.emit('stop');
    });

    micBtn.addEventListener('click', () => {
      if (!localStream) return;
      isMicMuted = !isMicMuted;
      localStream.getAudioTracks().forEach((t) => (t.enabled = !isMicMuted));
      micBtn.classList.toggle('muted', isMicMuted);
    });

    camBtn.addEventListener('click', () => {
      if (!localStream) return;
      isCamOff = !isCamOff;
      localStream.getVideoTracks().forEach((t) => (t.enabled = !isCamOff));
      camBtn.classList.toggle('muted', isCamOff);
    });

    reportBtn.addEventListener('click', () => reportModal.classList.remove('hidden'));

    const closeModal = () => {
      reportModal.classList.add('hidden');
      reportReason.value = '';
    };

    reportCancel.addEventListener('click', closeModal);
    modalClose.addEventListener('click', closeModal);
    reportModal.addEventListener('click', (e) => {
      if (e.target === reportModal) closeModal();
    });

    reportSubmit.addEventListener('click', () => {
      const reason = reportReason.value;
      if (!reason) return;
      socket.emit('report', { reason });
      closeModal();
      setStatus('report submitted');
    });

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });

    chatInput.addEventListener('input', () => {
      if (currentPeerId) {
        socket.emit('typing', { to: currentPeerId });
        clearTimeout(chatInput._typingTimer);
        chatInput._typingTimer = setTimeout(() => {
          if (currentPeerId) socket.emit('stop-typing', { to: currentPeerId });
        }, 1000);
      }
    });

    chatSendBtn.addEventListener('click', sendChatMessage);
  }

  /* ── Chat ── */

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || !currentPeerId) return;
    appendChatMessage(text, 'self');
    socket.emit('chat-message', { to: currentPeerId, text });
    chatInput.value = '';
    if (currentPeerId) socket.emit('stop-typing', { to: currentPeerId });
  }

  function appendChatMessage(text, type) {
    const div = document.createElement('div');
    div.className = `msg ${type}`;
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  let typingEl = null;

  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement('div');
    typingEl.className = 'typing-indicator';
    typingEl.textContent = 'stranger is typing…';
    chatMessages.appendChild(typingEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function hideTyping() {
    if (typingEl) { typingEl.remove(); typingEl = null; }
  }

  /* ── Screen transitions ── */

  function hideHome() { homeScreen.classList.remove('active'); }
  function showCall() { callScreen.classList.add('active'); }

  function showHome() {
    callScreen.classList.remove('active');
    homeScreen.classList.add('active');
    startBtn.disabled = false;
    chatMessages.innerHTML = '';
  }

  /* ── WebRTC ── */

  async function startPeerConnection(initiator) {
    cleanupPeerConnection();

    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    remoteFallback.style.display = 'flex';
    startTimer();

    peerConnection = new RTCPeerConnection(iceServers);

    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        setStatus('connected', 'active');
        setConnIndicator('connected', 'active');
        remoteFallback.style.display = 'none';
      } else if (state === 'disconnected' || state === 'failed') {
        setStatus('connection lost', 'error');
        setConnIndicator('lost', 'error');
      }
    };

    peerConnection.ontrack = (event) => {
      if (remoteVideo.srcObject !== event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        remoteFallback.style.display = 'none';
      }
    };

    if (localStream) {
      localStream.getTracks().forEach((t) => peerConnection.addTrack(t, localStream));
    }

    dataChannel = peerConnection.createDataChannel('chat');
    dataChannel.onopen = () => {
      chatInput.disabled = false;
      chatSendBtn.disabled = false;
    };

    if (initiator) {
      dataChannel.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'chat') appendChatMessage(msg.text, 'other');
          if (msg.type === 'typing') showTyping();
          if (msg.type === 'stop-typing') hideTyping();
        } catch {}
      };

      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { to: currentPeerId, data: { type: 'offer', sdp: offer.sdp } });
      } catch (err) {
        console.error('createOffer error', err);
      }
    } else {
      peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        dataChannel.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'chat') appendChatMessage(msg.text, 'other');
            if (msg.type === 'typing') showTyping();
            if (msg.type === 'stop-typing') hideTyping();
          } catch {}
        };
      };
    }

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && currentPeerId) {
        socket.emit('signal', { to: currentPeerId, data: { type: 'candidate', candidate: event.candidate } });
      }
    };
  }

  async function handleSignal(data) {
    if (!peerConnection) return;

    if (data.type === 'offer') {
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('signal', { to: currentPeerId, data: { type: 'answer', sdp: answer.sdp } });
      } catch (err) {
        console.error('handle offer error', err);
      }
    } else if (data.type === 'answer') {
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
      } catch (err) {
        console.error('handle answer error', err);
      }
    } else if (data.type === 'candidate' && data.candidate) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('addIceCandidate error', err);
      }
    }
  }

  function cleanupPeerConnection() {
    if (dataChannel) { dataChannel.close(); dataChannel = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    remoteVideo.srcObject = null;
    currentPeerId = null;
    isInitiator = false;
    chatInput.disabled = true;
    chatSendBtn.disabled = true;
    hideTyping();
    remoteFallback.style.display = 'flex';
  }

  function cleanupCall() {
    cleanupPeerConnection();
    isSearching = false;
  }

  init();
})();
