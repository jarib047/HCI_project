// Configure marked.js
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (err) {}
    }
    return code;
  },
  breaks: true,  // Convert \n to <br> in paragraphs
  gfm: true,     // Enable GitHub Flavored Markdown
  headerIds: false, // Disable header IDs to prevent XSS
  mangle: false,  // Disable mangling to prevent XSS
  sanitize: true  // Enable sanitization to prevent XSS
});

// Capture PID from URL
const urlParams = new URLSearchParams(window.location.search);
var participantID = "unknown";
var questionID = "unknown";
var delay_s = 3.0;
var condition = "direct";
var displayedPlanLabel = "GenAI";

const DIRECT_PLAN_BY_DCOND = {
  1: "GenAI - $8/month",
  2: "GenAI - $20/month",
  3: "GenAI - $250/month"
};

const ALL_PLAN_LABELS = Object.values(DIRECT_PLAN_BY_DCOND);

function stableIndexFromText(text, modulo) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % modulo;
}

function getDisplayedPlanLabel(dcond, currentCondition) {
  if (currentCondition === "alternate") {
    const seed = `${participantID}|${questionID}|${dcond}|${currentCondition}`;
    return ALL_PLAN_LABELS[stableIndexFromText(seed, ALL_PLAN_LABELS.length)];
  }

  return DIRECT_PLAN_BY_DCOND[dcond] || "GenAI";
}

function updateChatBranding(dcond) {
  displayedPlanLabel = getDisplayedPlanLabel(dcond, condition);
  const titleEl = document.getElementById("chat-title");
  if (titleEl) {
    titleEl.textContent = displayedPlanLabel;
  }
  document.title = displayedPlanLabel;
}

// Store conversation history and state
let conversationHistory = [];
let isRegenerating = false;
let responseCounter = 0;


function logNewEvent(type, identifier, content, latencyFT, latencyLT) {
   const payload = (typeof content === 'string') ? content : JSON.stringify(content);
           const timestamp = new Date().toISOString();
    const latencyFT_s = (latencyFT || 0) / 1000;
    const latencyLT_s = (latencyLT || 0) / 1000;

    const logData = {
      timestamp: timestamp,
      pid: participantID,
      qid: questionID,
      delay_condition: delay_s,
      condition: condition,
      type: type,
      target: identifier,
      content: payload,
      latency_ft: latencyFT_s,
      latency_lt: latencyLT_s
    };

    // Send to backend for S3 logging
    fetch('/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logData)
    }).catch(err => console.error('Failed to send log', err));

    // Still print to console for debugging
    console.log(`${timestamp} PID: ${participantID}, QID: ${questionID}, DELAY_CONDITION: ${delay_s}, CONDITION: ${condition}, PLAN: ${displayedPlanLabel}, type: ${type}, target: ${identifier}, content: "${payload}", latencyFT: ${latencyFT_s}, latencyLT: ${latencyLT_s}`);
 }

function restartConversation() {
  logNewEvent("new-chat", "", "", 0, 0);

  // Clear conversation history
  conversationHistory = [];
  
  // Clear chat box
  const chatBox = document.getElementById("chat-box");
  chatBox.innerHTML = "";
  
  // Clear input
  const input = document.getElementById("user-input");
  input.value = "";
  input.style.height = "auto";
  
  // Reset counter
  responseCounter = 0;
}

const textarea = document.getElementById("user-input");
textarea.addEventListener("input", () => {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 80) + "px";
});


// Handle Enter key
textarea.addEventListener("keydown", (e) => {
  // Check if it's Enter without Shift (Shift+Enter for new line)
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault(); // Prevent default Enter behavior
    if (!isRegenerating) {
      const sendBtn = document.querySelector(".send-btn");
      if (!sendBtn.disabled) {
        sendMessage();
      }
    }
  }
});

window.addEventListener('message', function(event) {
  // Detailed logging for debugging
  console.log("Received postMessage event. Full data:", event.data);
  console.log("PID:", event.data.pid);
  console.log("QID:", event.data.qid);
  console.log("DCOND:", event.data.dcond, "Type:", typeof event.data.dcond);
  console.log("CONDITION:", event.data.condition ?? event.data.cond);

  // Store the message with type checks
  participantID = event.data.pid || "unknown";
  questionID = event.data.qid || "unknown";
  let dcond = parseInt(event.data.dcond) || 0;  // Convert to number, default to 0 if NaN
  const incomingCondition = (event.data.condition || event.data.cond || "direct").toString().toLowerCase();
  condition = incomingCondition === "alternate" ? "alternate" : "direct";

  // Log the values after assignment
  console.log("After assignment - PID:", participantID);
  console.log("After assignment - QID:", questionID);
  console.log("After assignment - DCOND:", dcond);
  console.log("After assignment - CONDITION:", condition);

  switch (dcond) {
    case 1:
      delay_s = 2.0;
      break;
    case 2:
      delay_s = 9.0;
      break;
    case 3:
      delay_s = 20.0;
      break;
    default:
      delay_s = 3.0;
      break;
  }

  updateChatBranding(dcond);

});

function editMessage(editButton) {
  const actionItem = editButton.closest('.action-item');
  const userActions = actionItem.parentElement;
  const msgElement = userActions.previousElementSibling;
  const bubble = msgElement.querySelector('.bubble');
  const originalText = bubble.textContent;
  
  // Store original text for cancel functionality
  editButton.dataset.originalText = originalText;
  
  // Find the message index in conversation history
  const allUserMessages = document.querySelectorAll('.msg.user .bubble');
  const messageIndex = Array.from(allUserMessages).indexOf(bubble) * 2; // *2 because conversation history alternates user/assistant
  
  // Replace bubble with input field
  bubble.innerHTML = `
    <textarea class="edit-input" rows="3">${originalText}</textarea>
    <div class="edit-actions">
      <button onclick="cancelEdit(this)" class="cancel-btn">Cancel</button>
      <button onclick="saveEdit(this, ${messageIndex})" class="save-btn">Send</button>
    </div>
  `;
  
  // Focus the textarea
  const textarea = bubble.querySelector('.edit-input');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  
  // Auto-resize textarea as user types
  textarea.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 250) + 'px';
  });
  
  // Hide the edit and copy buttons while editing
  userActions.style.display = 'none';
}

function cancelEdit(cancelButton) {
  const bubble = cancelButton.closest('.bubble');
  const userActions = bubble.parentElement.nextElementSibling;
  const editButton = userActions.querySelector('.action-item .edit-btn');
  const originalText = editButton.dataset.originalText;
  
  // Restore original text
  bubble.textContent = originalText;
  
  // Show the edit and copy buttons
  userActions.style.display = 'flex';
}

async function saveEdit(saveButton, messageIndex) {
  // timing setup
  const generationStart = performance.now();
  const timestampStart = Date.now() / 1000.0; // Unix timestamp in seconds
  let firstTokenDelay = null;
  let totalDelay = null;

  const bubble = saveButton.closest('.bubble');
  const userActions = bubble.parentElement.nextElementSibling;
  const textarea = bubble.querySelector('.edit-input');
  const newText = textarea.value.trim();
  
  if (!newText) return;
  
  // Don't allow editing during regeneration
  if (isRegenerating) return;
  
  isRegenerating = true;
  
  // Update the bubble with new text
  bubble.textContent = newText;
  
  // Show the edit and copy buttons
  userActions.style.display = 'flex';
  
  // Update conversation history
  conversationHistory[messageIndex].content = newText;
  
  // Remove all messages after this point (both from history and DOM)
  conversationHistory = conversationHistory.slice(0, messageIndex + 1);
  
  // Remove all subsequent DOM elements
  const chatBox = document.getElementById("chat-box");
  const currentMsg = bubble.closest('.msg.user');
  let nextElement = userActions.nextElementSibling;
  while (nextElement) {
    const toRemove = nextElement;
    nextElement = nextElement.nextElementSibling;
    toRemove.remove();
  }
  
  // Disable buttons during regeneration
  const sendBtn = document.querySelector(".send-btn");
  const restartBtn = document.querySelector(".restart-btn");
  sendBtn.disabled = true;
  restartBtn.disabled = true;
  sendBtn.textContent = "●";
  document.querySelectorAll(".edit-btn, .copy-btn, .regenerate-btn").forEach(btn => {
    btn.disabled = true;
  });
  

  try {
    // Generate unique ID for this edited response
    responseCounter++;
    const editId = 'edit-' + responseCounter;
    
    // Add empty response container for streaming (no typing indicator)
    const editDiv = document.createElement('div');
    editDiv.className = 'msg bot';
    editDiv.id = `streaming-${editId}`;
    
    const editBubbleDiv = document.createElement('div');
    editBubbleDiv.className = 'bubble markdown-content';
    editBubbleDiv.id = `content-${editId}`;
    
    editDiv.appendChild(editBubbleDiv);
    chatBox.appendChild(editDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
    
    const streamingContent = editBubbleDiv;
    // Add initial cursor while waiting for first content
    streamingContent.innerHTML = '<span class="streaming-cursor"></span>';
    
    let fullResponse = "";

    await streamResponse(
      "/chat-stream",
      {
        message: newText,
        conversation_history: conversationHistory,
        delay: delay_s,
        pid: participantID,
        qid: questionID,
        condition: condition,
        start_time_s: timestampStart
      },
      // onChunk - handle each piece of content
      (content) => {
        if (firstTokenDelay === null) {
          firstTokenDelay = performance.now() - generationStart;
        }
        fullResponse += content;
        // Convert markdown to HTML in real-time and add cursor
        const formatted = marked.parse(fullResponse + '&#x200b;<span class="streaming-cursor"></span>');
        streamingContent.innerHTML = formatted;
        chatBox.scrollTop = chatBox.scrollHeight;
      },
      // onComplete - handle completion
      (data) => {
        // Timing metrics
        totalDelay = performance.now() - generationStart;

        // Remove cursor and update content
        const formatted = marked.parse(fullResponse);
        streamingContent.innerHTML = formatted;
        
        // Add assistant's response to conversation history
        conversationHistory.push({
          role: "assistant",
          content: fullResponse
        });

        // Calculate message index for regeneration button
        const newMessageIndex = conversationHistory.length - 2;

        // Remove the streaming ID and add action buttons
        editDiv.removeAttribute("id");
        
        // Create action buttons
        const editActionsDiv = document.createElement('div');
        editActionsDiv.className = 'msg-actions';
        
        const editRegenItem = document.createElement('div');
        editRegenItem.className = 'action-item';
        const editRegenBtn = document.createElement('button');
        editRegenBtn.className = 'regenerate-btn';
        editRegenBtn.setAttribute('aria-label', 'Redo');
        editRegenBtn.setAttribute('data-message-index', newMessageIndex.toString());
        editRegenBtn.innerHTML = '<img src="/static/refresh.png" alt="Regenerate" class="icon" />';
        const editRegenLabel = document.createElement('span');
        editRegenLabel.className = 'action-label';
        editRegenLabel.textContent = 'Redo';
        editRegenItem.appendChild(editRegenBtn);
        editRegenItem.appendChild(editRegenLabel);
        
        const editCopyItem = document.createElement('div');
        editCopyItem.className = 'action-item';
        const editCopyBtn = document.createElement('button');
        editCopyBtn.className = 'copy-btn';
        editCopyBtn.setAttribute('aria-label', 'Copy');
        editCopyBtn.onclick = () => copyMessage(fullResponse, editCopyBtn);
        editCopyBtn.innerHTML = '<img src="/static/copy.png" alt="Copy" class="icon" />';
        const editCopyLabel = document.createElement('span');
        editCopyLabel.className = 'action-label';
        editCopyLabel.textContent = 'Copy';
        editCopyItem.appendChild(editCopyBtn);
        editCopyItem.appendChild(editCopyLabel);
        
        editActionsDiv.appendChild(editRegenItem);
        editActionsDiv.appendChild(editCopyItem);
        chatBox.appendChild(editActionsDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
      },
      // onError - handle errors
      (error) => {
        streamingContent.innerHTML = `Error: ${error.message}`;
        chatBox.scrollTop = chatBox.scrollHeight;
      }
    );

  } catch (err) {
    if (streamingContent) {
      streamingContent.innerHTML = `Network error: ${err.message}`;
    }
  } finally {
    // Log the event
    logNewEvent("edit-generation", `chat-message-${messageIndex}`, conversationHistory, firstTokenDelay, totalDelay);

    // Re-enable all buttons
    const restartBtn = document.querySelector(".restart-btn");
    sendBtn.disabled = false;
    restartBtn.disabled = false;
    sendBtn.textContent = "➤";
    document.querySelectorAll(".edit-btn, .copy-btn, .regenerate-btn").forEach(btn => {
      btn.disabled = false;
    });
    
    // Reset regenerating state
    isRegenerating = false;
  }
}

async function streamResponse(url, requestData, onChunk, onComplete, onError) {
  try {
    // Create AbortController for timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes timeout
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestData),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Declare variables outside the loop so they persist
    let completeData = null;
    let errorData = null;
    let lastActivity = Date.now();

    while (true) {
      // Check for inactivity timeout (30 seconds without data)
      if (Date.now() - lastActivity > 30000) {
        throw new Error('Stream timeout: No data received for 30 seconds');
      }
      
      const { done, value } = await reader.read();
      if (done) {
        console.log('[DEBUG] Stream done, breaking loop');
        break;
      }
      
      lastActivity = Date.now(); // Update activity timestamp

      const chunk = decoder.decode(value);
      console.log(`[DEBUG] Received chunk: ${chunk.length} bytes`);
      const lines = chunk.split('\n');
      console.log(`[DEBUG] Split into ${lines.length} lines`);

      // Process all lines in the chunk to ensure we don't miss any content
      let contentCount = 0;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.type === 'content') {
              contentCount++;
              console.log(`[DEBUG] Processing content chunk ${contentCount}: "${data.content}"`);
              onChunk(data.content);
            } else if (data.type === 'complete') {
              completeData = data;  // Store for later processing
              console.log(`[DEBUG] Found complete message in chunk with ${contentCount} content messages`);
              console.log(`[DEBUG] Complete message data:`, data);
            } else if (data.type === 'error') {
              errorData = data;  // Store for later processing
              console.log(`[DEBUG] Found error message in chunk with ${contentCount} content messages`);
            } else {
              console.log(`[DEBUG] Unknown message type: ${data.type}`, data);
            }
          } catch (e) {
            console.error('Error parsing SSE data:', e, 'Line:', line);
          }
        } else if (line.trim() !== '') {
          console.log(`[DEBUG] Non-data line: "${line}"`);
        }
      }

      // After processing all lines in the chunk, handle complete/error
      if (errorData) {
        onError(new Error(errorData.error));
        return;
      }
      
      // Don't return immediately on complete - continue reading the stream
      // The complete message should be the last thing, but we need to ensure
      // we've read all data before calling onComplete
      if (completeData) {
        // Continue reading to ensure we get all data, then call onComplete
        console.log(`[DEBUG] Found complete message, continuing to read stream...`);
      }
    }
    
    // After the stream is completely done, call onComplete if we found it
    if (completeData) {
      clearTimeout(timeoutId);
      onComplete(completeData);
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      onError(new Error('Request timeout: Stream took too long to complete'));
    } else {
      onError(error);
    }
  }
}

async function copyMessage(text, button) {
  const originalIcon = button.innerHTML;
  let success = false;
  
  try {
    // Try modern Clipboard API first
    await navigator.clipboard.writeText(text);
    success = true;
  } catch (err) {
    console.log('Clipboard API failed, trying fallback method:', err);
    
    // Fallback for iframes and older browsers
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      textArea.style.opacity = '0';
      textArea.style.pointerEvents = 'none';
      document.body.appendChild(textArea);
      textArea.focus({ preventScroll: true });
      textArea.select();
      
      success = document.execCommand('copy');
      document.body.removeChild(textArea);
    } catch (fallbackErr) {
      console.error('Both clipboard methods failed:', fallbackErr);
      success = false;
    }
  }
  
  if (success) {
    // Visual feedback for success
    button.innerHTML = '<span class="icon">✓</span>';
    button.style.color = '#28a745';
    
    // Reset after 2 seconds
    setTimeout(() => {
      button.innerHTML = originalIcon;
      button.style.color = '';
    }, 2000);
  } else {
    // Visual feedback for error
    button.innerHTML = '<span class="icon">✗</span>';
    button.style.color = '#dc3545';
    
    setTimeout(() => {
      button.innerHTML = originalIcon;
      button.style.color = '';
    }, 2000);
  }
}

async function regenerateResponse(messageIndex, triggerBtn = null) {
  // timing setup
  const generationStart = performance.now();
  const timestampStart = Date.now() / 1000.0; // Unix timestamp in seconds
  let firstTokenDelay = null;
  let totalDelay = null;

  // Set regenerating state
  isRegenerating = true;
  
  const sendBtn = document.querySelector(".send-btn");
  const chatBox = document.getElementById("chat-box");
  
  // Get the original user message
  const originalMessage = conversationHistory[messageIndex].content;
  
  // Remove messages after this point from conversation history (keep the user message, remove the assistant response and everything after)
  conversationHistory = conversationHistory.slice(0, messageIndex + 1);
  
  // Try to locate the target user message in the DOM using the trigger button (more reliable)
  let targetUserMessage = null;
  if (triggerBtn) {
    const botActionsDiv = triggerBtn.closest('.msg-actions');
    const botMsgDiv = botActionsDiv ? botActionsDiv.previousElementSibling : null; // .msg.bot
    const userActionsDiv = botMsgDiv ? botMsgDiv.previousElementSibling : null;   // .msg-actions.user-actions
    targetUserMessage = userActionsDiv ? userActionsDiv.previousElementSibling : null; // .msg.user
  }

  // Fallback to index-based lookup if above method failed
  if (!targetUserMessage) {
    const allUserMessages = chatBox.querySelectorAll('.msg.user');
    const userMessageIndex = Math.floor(messageIndex / 2); // Convert conversation history index to DOM index
    targetUserMessage = allUserMessages[userMessageIndex];
  }
  
  if (targetUserMessage) {
    // Find the user actions div that comes after the target user message
    const userActionsDiv = targetUserMessage.nextElementSibling;
    
    // Remove all elements that come after the user actions div
    let elementToRemove = userActionsDiv ? userActionsDiv.nextElementSibling : targetUserMessage.nextElementSibling;
    const elementsToRemove = [];
    
    // Collect all elements after the user actions (bot reply, its actions, and any later content)
    while (elementToRemove) {
      elementsToRemove.push(elementToRemove);
      elementToRemove = elementToRemove.nextElementSibling;
    }
    
    // Remove all collected elements
    elementsToRemove.forEach(element => element.remove());
  } else {
    // Fallback: remove all bot messages and their actions from the chat box
    const allBotMessages = chatBox.querySelectorAll('.msg.bot');
    const allBotActions = chatBox.querySelectorAll('.msg-actions:not(.user-actions)');
    
    // Remove bot messages and their actions
    allBotMessages.forEach(msg => msg.remove());
    allBotActions.forEach(actions => actions.remove());
  }
  
  // Additional cleanup: remove any orphaned action buttons (action buttons without a preceding message)
  const allActionButtons = chatBox.querySelectorAll('.msg-actions');
  allActionButtons.forEach(actionDiv => {
    const prevElement = actionDiv.previousElementSibling;
    // If the previous element is not a .msg element, this action button is orphaned
    if (!prevElement || !prevElement.classList.contains('msg')) {
      actionDiv.remove();
    }
  });
  
  // Disable all buttons during generation
  const restartBtn = document.querySelector(".restart-btn");
  document.querySelectorAll(".regenerate-btn").forEach(btn => {
    btn.disabled = true;
    btn.innerHTML = '<span class="icon">●</span>';
  });
  sendBtn.disabled = true;
  restartBtn.disabled = true;
  sendBtn.textContent = "●";
  

  try {
    // Generate unique ID for this regenerated response
    responseCounter++;
    const regenId = 'regen-' + responseCounter;
    
    // Add empty response container for streaming (no typing indicator)
    const regenDiv = document.createElement('div');
    regenDiv.className = 'msg bot';
    regenDiv.id = `streaming-${regenId}`;
    
    const regenBubbleDiv = document.createElement('div');
    regenBubbleDiv.className = 'bubble markdown-content';
    regenBubbleDiv.id = `content-${regenId}`;
    
    regenDiv.appendChild(regenBubbleDiv);
    chatBox.appendChild(regenDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
    
    const streamingContent = regenBubbleDiv;
    // Add initial cursor while waiting for first content
    streamingContent.innerHTML = '<span class="streaming-cursor"></span>';
    
    let fullResponse = "";

    await streamResponse(
      "/chat-stream",
      {
        message: originalMessage,
        conversation_history: conversationHistory,
        delay: delay_s,
        pid: participantID,
        qid: questionID,
        condition: condition,
        start_time_s: timestampStart
      },
      // onChunk - handle each piece of content
      (content) => {
        if (firstTokenDelay === null) {
          firstTokenDelay = performance.now() - generationStart;
        }
        fullResponse += content;
        // Convert markdown to HTML in real-time and add cursor
        const formatted = marked.parse(fullResponse + '&#x200b;<span class="streaming-cursor"></span>');
        streamingContent.innerHTML = formatted;
        chatBox.scrollTop = chatBox.scrollHeight;
      },
      // onComplete - handle completion
      (data) => {
        // Timing metrics
        totalDelay = performance.now() - generationStart;

        // Remove cursor and update content
        const formatted = marked.parse(fullResponse);
        streamingContent.innerHTML = formatted;
        
        // Add assistant's response to conversation history
        conversationHistory.push({
          role: "assistant",
          content: fullResponse
        });

        // Remove the streaming ID and add action buttons
        regenDiv.removeAttribute("id");
        
        // Create action buttons
        const regenActionsDiv = document.createElement('div');
        regenActionsDiv.className = 'msg-actions';
        
        const regenRegenItem = document.createElement('div');
        regenRegenItem.className = 'action-item';
        const regenRegenBtn = document.createElement('button');
        regenRegenBtn.className = 'regenerate-btn';
        regenRegenBtn.setAttribute('aria-label', 'Redo');
        regenRegenBtn.setAttribute('data-message-index', messageIndex.toString());
        regenRegenBtn.innerHTML = '<img src="/static/refresh.png" alt="Regenerate" class="icon" />';
        const regenRegenLabel = document.createElement('span');
        regenRegenLabel.className = 'action-label';
        regenRegenLabel.textContent = 'Redo';
        regenRegenItem.appendChild(regenRegenBtn);
        regenRegenItem.appendChild(regenRegenLabel);
        
        const regenCopyItem = document.createElement('div');
        regenCopyItem.className = 'action-item';
        const regenCopyBtn = document.createElement('button');
        regenCopyBtn.className = 'copy-btn';
        regenCopyBtn.setAttribute('aria-label', 'Copy');
        regenCopyBtn.onclick = () => copyMessage(fullResponse, regenCopyBtn);
        regenCopyBtn.innerHTML = '<img src="/static/copy.png" alt="Copy" class="icon" />';
        const regenCopyLabel = document.createElement('span');
        regenCopyLabel.className = 'action-label';
        regenCopyLabel.textContent = 'Copy';
        regenCopyItem.appendChild(regenCopyBtn);
        regenCopyItem.appendChild(regenCopyLabel);
        
        regenActionsDiv.appendChild(regenRegenItem);
        regenActionsDiv.appendChild(regenCopyItem);
        chatBox.appendChild(regenActionsDiv);
        chatBox.scrollTop = chatBox.scrollHeight;

      },
      // onError - handle errors
      (error) => {
        streamingContent.innerHTML = `Error: ${error.message}`;
        chatBox.scrollTop = chatBox.scrollHeight;
      }
    );

  } catch (err) {
    // Remove typing indicator in case of network error
    const typingIndicator = document.getElementById("typing-indicator");
    if (typingIndicator) {
      typingIndicator.remove();
    }
    chatBox.innerHTML += `<div class="msg bot"><div class="bubble">Network error: ${err.message}</div></div>`;
  } finally {
    // Log the event
    logNewEvent("re-generation", `chat-message-${messageIndex}`, conversationHistory, firstTokenDelay, totalDelay);

    // Re-enable all buttons
    const restartBtn = document.querySelector(".restart-btn");
    document.querySelectorAll(".regenerate-btn").forEach(btn => {
      btn.disabled = false;
                  btn.innerHTML = '<img src="/static/refresh.png" alt="Regenerate" class="icon" />';
    });
    sendBtn.disabled = false;
    restartBtn.disabled = false;
    sendBtn.textContent = "➤";
    
    // Reset regenerating state
    isRegenerating = false;
  }
}

async function sendMessage() {
  // timing setup
  const generationStart = performance.now();
  const timestampStart = Date.now() / 1000.0; // Unix timestamp in seconds
  let firstTokenDelay = null;
  let totalDelay = null;

  // Don't allow new messages during regeneration
  if (isRegenerating) return;

  const input = document.getElementById("user-input");
  const sendBtn = document.querySelector(".send-btn");
  const chatBox = document.getElementById("chat-box");
  const msg = input.value.trim();
  if (!msg) return;

  // Prevent multiple submissions
  if (sendBtn.disabled) return;

  // Disable all interactive buttons and show loading state
  const restartBtn = document.querySelector(".restart-btn");
  sendBtn.disabled = true;
  restartBtn.disabled = true;
  sendBtn.textContent = "●";
  
  // Clear and reset input
  input.value = "";
  input.style.height = "auto";
  
  // Disable all regenerate buttons during response
  document.querySelectorAll(".regenerate-btn").forEach(btn => {
    btn.disabled = true;
  });

  // Add user message to conversation history
  conversationHistory.push({
    role: "user",
    content: msg
  });

  // Show user message
  chatBox.innerHTML += `
    <div class="msg user">
      <div class="bubble">${msg}</div>
    </div>
    <div class="msg-actions user-actions">
      <div class="action-item">
        <button onclick="editMessage(this)" class="edit-btn" aria-label="Edit">
          <img src="/static/pencil.png" alt="Edit" class="icon" />
        </button>
        <span class="action-label">Edit</span>
      </div>
      <div class="action-item">
        <button onclick="copyMessage('${msg.replace(/'/g, "\\'")}', this)" class="copy-btn" aria-label="Copy">
          <img src="/static/copy.png" alt="Copy" class="icon" />
        </button>
        <span class="action-label">Copy</span>
      </div>
    </div>`;
  
  // Add typing indicator
  chatBox.innerHTML += `
    <div class="msg bot" id="typing-indicator">
      <div class="typing-indicator">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>`;
  chatBox.scrollTop = chatBox.scrollHeight;

  // Log values before sending
  console.log("Sending request with values:");
  console.log("Message:", msg);
  console.log("Delay:", delay_s);
  console.log("PID:", participantID);
  console.log("QID:", questionID);
  console.log("Condition:", condition);
  console.log("Displayed plan:", displayedPlanLabel);

  // Remove typing indicator and add streaming response container
  const typingIndicator = document.getElementById("typing-indicator");
  if (typingIndicator) {
    typingIndicator.remove();
  }

  // Generate unique ID for this response
  responseCounter++;
  const responseId = 'response-' + responseCounter;
  
  // Add empty response container for streaming
  const responseDiv = document.createElement('div');
  responseDiv.className = 'msg bot';
  responseDiv.id = `streaming-${responseId}`;
  
  const bubbleDiv = document.createElement('div');
  bubbleDiv.className = 'bubble markdown-content';
  bubbleDiv.id = `content-${responseId}`;
  
  responseDiv.appendChild(bubbleDiv);
  chatBox.appendChild(responseDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
  
  const streamingContent = bubbleDiv;
  // Add initial cursor while waiting for first content
  streamingContent.innerHTML = '<span class="streaming-cursor"></span>';
  
  let fullResponse = "";

  try {
    await streamResponse(
      "/chat-stream",
      {
        message: msg,
        conversation_history: conversationHistory,
        delay: delay_s,
        pid: participantID,
        qid: questionID,
        condition: condition,
        start_time_s: timestampStart
      },
      // onChunk - handle each piece of content
      (content) => {
        if (firstTokenDelay === null) {
          firstTokenDelay = performance.now() - generationStart;
        }
        fullResponse += content;
        // Convert markdown to HTML in real-time and add cursor
        const formatted = marked.parse(fullResponse + '&#x200b;<span class="streaming-cursor"></span>');
        streamingContent.innerHTML = formatted;
        chatBox.scrollTop = chatBox.scrollHeight;
      },
      // onComplete - handle completion
      (data) => {
        // Timing metrics
        totalDelay = performance.now() - generationStart;

        // Remove cursor and update content
        const formatted = marked.parse(fullResponse);
        streamingContent.innerHTML = formatted;
        
        // Add assistant's response to conversation history
        conversationHistory.push({
          role: "assistant",
          content: fullResponse
        });

        // Calculate the message index for regeneration (find the user message that triggered this response)
        const messageIndex = conversationHistory.length - 2;
        
        // Remove the streaming ID and add action buttons
        responseDiv.removeAttribute("id");
        
        // Create action buttons
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'msg-actions';
        
        const regenItem = document.createElement('div');
        regenItem.className = 'action-item';
        const regenBtn = document.createElement('button');
        regenBtn.className = 'regenerate-btn';
        regenBtn.setAttribute('aria-label', 'Redo');
        regenBtn.setAttribute('data-message-index', messageIndex.toString());
        regenBtn.innerHTML = '<img src="/static/refresh.png" alt="Regenerate" class="icon" />';
        const regenLabel = document.createElement('span');
        regenLabel.className = 'action-label';
        regenLabel.textContent = 'Redo';
        regenItem.appendChild(regenBtn);
        regenItem.appendChild(regenLabel);
        
        const copyItem = document.createElement('div');
        copyItem.className = 'action-item';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.setAttribute('aria-label', 'Copy');
        // copyBtn.onclick = function() { copyMessage(fullResponse, this); };
        copyBtn.innerHTML = '<img src="/static/copy.png" alt="Copy" class="icon" />';
        const copyLabel = document.createElement('span');
        copyLabel.className = 'action-label';
        copyLabel.textContent = 'Copy';
        copyItem.appendChild(copyBtn);
        copyItem.appendChild(copyLabel);
        
        actionsDiv.appendChild(regenItem);
        actionsDiv.appendChild(copyItem);
        chatBox.appendChild(actionsDiv);
        chatBox.scrollTop = chatBox.scrollHeight;
      },
      // onError - handle errors
      (error) => {
        streamingContent.innerHTML = `Error: ${error.message}`;
        chatBox.scrollTop = chatBox.scrollHeight;
      }
    );

  } catch (err) {
    if (streamingContent) {
      streamingContent.innerHTML = `Network error: ${err.message}`;
    }
    chatBox.scrollTop = chatBox.scrollHeight;
  } finally {
    // Log the event
    logNewEvent("new-generation", ``, conversationHistory, firstTokenDelay, totalDelay);

    // Re-enable all buttons
    const restartBtn = document.querySelector(".restart-btn");
    sendBtn.disabled = false;
    restartBtn.disabled = false;
    sendBtn.textContent = "➤";
    document.querySelectorAll(".regenerate-btn").forEach(btn => {
      btn.disabled = false;
    });
    input.focus();
  }
}

// Optional: predefined prompts
document.querySelectorAll(".prompt").forEach(btn =>
  btn.onclick = () => {
    document.getElementById("user-input").value = btn.textContent;
  }
);

// Global delegation for regenerate buttons (handles clicks on all existing and future buttons)
// Delegated click handler for regenerate buttons
document.addEventListener('click', function(event) {
  const btn = event.target.closest('.regenerate-btn');
  if (!btn || btn.disabled) return;
  const idx = parseInt(btn.getAttribute('data-message-index'));
  if (!isNaN(idx)) {
    regenerateResponse(idx, btn);
  }
});

// Delegated click handler for copy buttons
document.addEventListener('click', function(event) {
  const copyBtn = event.target.closest('.copy-btn');
  if (!copyBtn || copyBtn.disabled) return;

  // Determine target identifier for logging
  let targetIdentifier = 'copy-button-unknown';
  const actionsDiv = copyBtn.closest('.msg-actions');
  const msgDiv = actionsDiv ? actionsDiv.previousElementSibling : null;
  if (msgDiv) {
    const chatBox = document.getElementById('chat-box');
    if (chatBox) {
      const msgs = Array.from(chatBox.querySelectorAll('.msg'));
      const idx = msgs.indexOf(msgDiv);
      if (idx !== -1) {
        targetIdentifier = `chat-message-${idx}`;
      }
    }
  }

  // Retrieve text to copy
  let textToCopy = copyBtn.getAttribute('data-copy-text');
  if (!textToCopy) {
    const bubble = msgDiv ? msgDiv.querySelector('.bubble') : null;
    if (bubble) {
      textToCopy = bubble.textContent || bubble.innerText || '';
    }
  }

  // Log with content (truncate to 200 chars for safety)
  const content = (textToCopy || '');
  logNewEvent("copy-button", targetIdentifier, content, 0, 0);
  
  if (textToCopy) {
    copyMessage(textToCopy, copyBtn);
  }
});

// ------------------------------
// Clipboard event tracking
// ------------------------------
(function () {
  // Helper to generate a human-readable identifier for the event target
  function getTargetIdentifier(target) {
    if (!target) return "unknown";

    // Prompt input field (user text area)
    const promptInput = document.getElementById("user-input");
    if (target === promptInput || promptInput.contains(target)) {
      return "prompt-input";
    }

    // Chat message (bubble or descendant of a .msg wrapper)
    const chatMsg = target.closest && target.closest("#chat-box .msg");
    if (chatMsg) {
      const chatBox = document.getElementById("chat-box");
      if (chatBox) {
        const msgs = Array.from(chatBox.querySelectorAll(".msg"));
        const index = msgs.indexOf(chatMsg);
        if (index !== -1) {
          return `chat-message-${index}`;
        }
      }
      // Couldn't determine position
      return "chat-message-unknown";
    }

    // Fallback
    return "unknown";
  }

  function logClipboardEvent(e) {
    const identifier = getTargetIdentifier(e.target || document.activeElement);

    let content = '';
    if (e.type === 'paste') {
      content = (e.clipboardData && e.clipboardData.getData('text')) || '';
    } else { // copy or cut
      content = document.getSelection().toString();
    }

    logNewEvent(e.type, identifier, content, 0, 0);
  }

  // Capture phase listener so we catch events early
  ["copy", "cut", "paste"].forEach(evt =>
    document.addEventListener(evt, logClipboardEvent, true)
  );
})();
