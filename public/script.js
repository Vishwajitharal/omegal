(function () {
  'use strict';

  const socket = io();
  let iceServers = null;
  let localStream = null;
  let peerConnection = null;
  let dataChannel = null;
  let currentPeerId = null;
  let isInitiator = false;
  let isMicMuted = false;
  let isCamOff = false;
  let isSearching = false;
  let chatPartner = null;

  const $ = (sel) => document.querySelector(sel);
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
  const toggleChatBtn = $('#toggle-chat-btn');
  const chatPanel = $('#chat-panel');
  const chatMessages = $('#chat-messages');
  const chatInput = $('#chat-input');
  const chatSendBtn = $('#chat-send-btn');
  const reportModal = $('#report-modal');
  const reportReason = $('#report-reason');
  const reportCancel = $('#report-cancel');
  const reportSubmit = $('#report-submit');

  async function init() {
    try {
      const res = await fetch('/ice-servers');
      iceServers = await res.json();
    } catch {
      iceServers = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      };
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localPreview.srcObject = localStream;
      localVideo.srcObject = localStream;
      startBtn.disabled = false;
    } catch (err) {
      statusText.textContent = 'Camera/mic access denied';
      startBtn.disabled = true;
    }

    setupSocket();
    setupUI();
  }

  function setStatus(text, isActive = false) {
    statusText.textContent = text;
    statusText.style.color = isActive ? 'var(--primary)' : '';
  }

  function setupSocket() {
    socket.on('waiting', () => {
      setStatus('Searching for a stranger…', true);
      isSearching = true;
    });

    socket.on('matched', async ({ roomId, initiator, peerId }) => {
      isSearching = false;
      currentPeerId = peerId;
      isInitiator = initiator;
      setStatus('Connecting…', true);
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
      if (reason === 'next') {
        setStatus('Stranger left. Searching again…', true);
        socket.emit('find-match');
      } else {
        setStatus('Stranger disconnected', false);
      }
    });

    socket.on('stopped', () => {
      cleanupCall();
      showHome();
      setStatus('Ready');
    });

    socket.on('chat-message', ({ from, text }) => {
      if (from === currentPeerId) {
        appendChatMessage(text, 'other');
      }
    });

    socket.on('typing', ({ from }) => {
      if (from === currentPeerId) showTyping();
    });

    socket.on('stop-typing', ({ from }) => {
      if (from === currentPeerId) hideTyping();
    });
  }

  function setupUI() {
    startBtn.addEventListener('click', () => {
      if (!localStream) return;
      startBtn.disabled = true;
      setStatus('Searching…', true);
      socket.emit('find-match');
    });

    nextBtn.addEventListener('click', () => {
      cleanupPeerConnection();
      setStatus('Searching…', true);
      socket.emit('next');
    });

    stopBtn.addEventListener('click', () => {
      cleanupPeerConnection();
      socket.emit('stop');
    });

    micBtn.addEventListener('click', () => {
      if (!localStream) return;
      isMicMuted = !isMicMuted;
      localStream.getAudioTracks().forEach((t) => (t.enabled = !isMicMuted));
      micBtn.classList.toggle('muted', isMicMuted);
      micBtn.textContent = isMicMuted ? 'Muted' : 'Mic';
    });

    camBtn.addEventListener('click', () => {
      if (!localStream) return;
      isCamOff = !isCamOff;
      localStream.getVideoTracks().forEach((t) => (t.enabled = !isCamOff));
      camBtn.classList.toggle('muted', isCamOff);
      camBtn.textContent = isCamOff ? 'Off' : 'Cam';
    });

    reportBtn.addEventListener('click', () => {
      reportModal.classList.remove('hidden');
    });

    reportCancel.addEventListener('click', () => {
      reportModal.classList.add('hidden');
      reportReason.value = '';
    });

    reportSubmit.addEventListener('click', () => {
      const reason = reportReason.value;
      if (!reason) return;
      socket.emit('report', { reason });
      reportModal.classList.add('hidden');
      reportReason.value = '';
      setStatus('Report submitted', false);
    });

    toggleChatBtn.addEventListener('click', () => {
      chatPanel.classList.toggle('collapsed');
      toggleChatBtn.textContent = chatPanel.classList.contains('collapsed') ? '\u25B2' : '\u00D7';
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

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || !currentPeerId) return;
    appendChatMessage(text, 'self');
    socket.emit('chat-message', { to: currentPeerId, text });
    chatInput.value = '';
    if (currentPeerId) {
      socket.emit('stop-typing', { to: currentPeerId });
    }
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
    typingEl.textContent = 'Stranger is typing…';
    chatMessages.appendChild(typingEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function hideTyping() {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  function hideHome() {
    homeScreen.classList.remove('active');
  }

  function showCall() {
    callScreen.classList.add('active');
  }

  function showHome() {
    callScreen.classList.remove('active');
    homeScreen.classList.add('active');
    startBtn.disabled = false;
    chatMessages.innerHTML = '';
  }

  async function startPeerConnection(initiator) {
    cleanupPeerConnection();

    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    remoteFallback.style.display = 'flex';

    peerConnection = new RTCPeerConnection(iceServers);

    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        setStatus('Connected', true);
        remoteFallback.style.display = 'none';
      } else if (state === 'disconnected' || state === 'failed') {
        setStatus('Connection lost', false);
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
        const msg = JSON.parse(e.data);
        if (msg.type === 'chat') appendChatMessage(msg.text, 'other');
        if (msg.type === 'typing') showTyping();
        if (msg.type === 'stop-typing') hideTyping();
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
          const msg = JSON.parse(e.data);
          if (msg.type === 'chat') appendChatMessage(msg.text, 'other');
          if (msg.type === 'typing') showTyping();
          if (msg.type === 'stop-typing') hideTyping();
        };
      };
    }

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && currentPeerId) {
        socket.emit('signal', {
          to: currentPeerId,
          data: { type: 'candidate', candidate: event.candidate },
        });
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
    if (dataChannel) {
      dataChannel.close();
      dataChannel = null;
    }
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
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
