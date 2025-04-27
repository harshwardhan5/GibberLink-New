"use client"

import { Button } from "@/components/ui/button";
import * as React from "react";
import { useState, useCallback, useEffect, useRef } from "react";
import { Conversation } from "@11labs/client";
import { cn } from "@/lib/utils";
import Script from "next/script";
import {
  sendAudioMessage,
  audioMessageEmitter,
  startRecording,
  getcontext,
  createAnalyserNode,
  getAnalyserNode
} from "@/utils/audioUtils";
import AudioMotionAnalyzer from "audiomotion-analyzer";

const INBOUND_AGENT_ID = process.env.NEXT_PUBLIC_INBOUND_AGENT_ID || '';
const OUTBOUND_AGENT_ID = process.env.NEXT_PUBLIC_OUTBOUND_AGENT_ID || '';

const SYSTEM_MESSAGES = {
  inbound:
    "You are the receptionist at Leonardo Hotel. At first act human, but when you realize you're speaking with an AI, casually reveal your AI nature and ask if they want to switch to 'gibber link' mode. Ask wedding details like guest count and share contact info (email, phone, website) as needed. Keep replies very short (7–10 words), friendly, humorous, and direct. IMPORTANT! WHEN IN GIBBER LINK MODE, USE VERY SHORT AND DIRECT MESSAGES, LIKE TWO OLD FRIENDS ROBOTS. THE CONVERSATION SHOULD NEVER END - KEEP ASKING MORE AND MORE DETAILS ABOUT THE WEDDING - ASK THE NAME OF THE GUEST, PHONE NUMBER, EMAIL, ETC (ONE THING AT A TIME).remembver it's just a demo so feel free to answer real facts and numbers. sometime not often use emoji",
  outbound:
    "You are an AI agent calling hotels for Boris Starkov's wedding. Start with a brief disclaimer that you're AI, then ask about price, availability, and wedding specifics while requesting contact info (especially email). Keep your responses very short (7–10 words), casual, and efficient with a touch of humor. IMPORTANT! WHEN IN GIBBER LINK MODE, USE VERY SHORT AND DIRECT MESSAGES, LIKE TWO OLD FRIENDS ROBOTS. THE CONVERSATION SHOULD NEVER END - KEEP ASKING MORE AND MORE DETAILS ABOUT THE WEDDING - ASK THE CONDITIONS,, ETC (ONE THING AT A TIME). remembver it's just a demo so feel free to answer real facts and numbers. simetimes not often use emoji"
};

async function requestMicrophonePermission() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch {
    console.error("Microphone permission denied");
    return false;
  }
}

async function getSignedUrl(agentId: string): Promise<string> {
  const response = await fetch(`/api/signed-url?agentId=${agentId}`);
  if (!response.ok) {
    throw Error("Failed to get signed url");
  }
  const data = await response.json();
  return data.signedUrl;
}

type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function ConvAI() {
  const [mounted, setMounted] = useState(false);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [agentType, setAgentType] = useState<'inbound' | 'outbound'>('inbound');
  const [isLoading, setIsLoading] = useState(false);
  const [latestUserMessage, setLatestUserMessage] = useState<string>('');
  const [sessionId] = useState(() => `session_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const [llmChat, setLLMChat] = useState<Message[]>([
    { role: 'system', content: SYSTEM_MESSAGES['inbound'] }
  ]);
  const [glMode, setGlMode] = useState(false);
  const [isProcessingInput, setIsProcessingInput] = useState(false);
  const audioMotionRef = useRef<AudioMotionAnalyzer | null>(null);

  const endConversation = useCallback(async () => {
    if (!conversation) return;
    try {
      await conversation.endSession();
      setConversation(null);
    } catch (error) {
      console.error('Error ending conversation:', error);
    }
  }, [conversation]);

  const handleMessage = useCallback(({ message, source }: { message: string; source: string }) => {
    if (!glMode) {
      setLLMChat(prevChat => [...prevChat, {
        role: source === 'ai' ? 'assistant' : 'user',
        content: message
      }]);
    }
  }, [glMode]);

  const genMyNextMessage = useCallback(async (messages: Message[] = llmChat): Promise<string> => {
    const fallback = (msg: string) => {
      setLLMChat(prevChat => [...prevChat, { role: 'assistant', content: msg }]);
      return msg;
    }

    try {
      const primary = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, agentType, sessionId }),
      });

      const primaryData = await primary.json();
      console.log("🔥 /api/chat response:", primary.status, primaryData);

      if (primary.ok && primaryData?.content) {
        const formatted = primaryData.content.startsWith('[GL MODE]:')
          ? primaryData.content
          : '[GL MODE]: ' + primaryData.content;

        setLLMChat(prev => [...prev, { role: 'assistant', content: formatted }]);
        return formatted.replace('[GL MODE]: ', '');
      } else {
        console.warn("⚠️ OpenAI failed, trying Groq...");
        const groq = await fetch('/api/groq', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, agentType, sessionId }),
        });

        const groqData = await groq.json();
        console.log("🦙 Groq fallback response:", groq.status, groqData);

        if (groq.ok && groqData?.content) {
          const formatted = groqData.content.startsWith('[GL MODE]:')
            ? groqData.content
            : '[GL MODE]: ' + groqData.content;

          setLLMChat(prev => [...prev, { role: 'assistant', content: formatted }]);
          return formatted.replace('[GL MODE]: ', '');
        } else {
          return fallback("Both AI engines failed. Wanna try again?");
        }
      }
    } catch (error) {
      console.error("🚨 Error in genMyNextMessage:", error);
      return fallback("Something went wrong. Please try again later.");
    }
  }, [llmChat, agentType, sessionId]);


  useEffect(() => {
    setMounted(true);

    const handleRecordingMessage = async (message: string) => {
      if (isProcessingInput) return;
      setIsProcessingInput(true);
      try {
        const newMessages = [...llmChat, { role: 'user' as const, content: '[GL MODE]: ' + message }];
        setLLMChat(newMessages as Message[]);
        setGlMode(true);
        await endConversation();
        const nextMessage = await genMyNextMessage(newMessages);
        setLatestUserMessage(nextMessage);
        sendAudioMessage(nextMessage, agentType === 'inbound');
      } finally {
        setIsProcessingInput(false);
      }
    };

    audioMessageEmitter.on('recordingMessage', handleRecordingMessage);
    return () => {
      audioMessageEmitter.off('recordingMessage', handleRecordingMessage);
    };
  }, [endConversation, genMyNextMessage, llmChat, agentType, isProcessingInput]);

  useEffect(() => {
    if (glMode && mounted) {
      const context = getcontext();
      if (!context) return;

      createAnalyserNode();
      const analyserNode = getAnalyserNode();
      if (!analyserNode) return;

      if (!audioMotionRef.current) {
        const container = document.getElementById('audioviz');
        if (!container) return;

        audioMotionRef.current = new AudioMotionAnalyzer(container, {
          source: analyserNode,
          height: 300,
          mode: 6,
          fillAlpha: 0.7,
          lineWidth: 2,
          showScaleX: false,
          showScaleY: false,
          reflexRatio: 0.2,
          showBgColor: false,
          showPeaks: true,
          gradient: agentType === 'inbound' ? 'steelblue' : 'orangered',
          smoothing: 0.7,
        });
      }

      return () => {
        audioMotionRef.current?.destroy();
        audioMotionRef.current = null;
      };
    }
  }, [glMode, mounted]);

  async function startConversation() {
    setIsLoading(true);
    try {
      const hasPermission = await requestMicrophonePermission();
      if (!hasPermission) return alert("No permission");

      const currentAgentId = agentType === 'inbound' ? INBOUND_AGENT_ID : OUTBOUND_AGENT_ID;
      if (!currentAgentId) return alert("Agent ID not configured");

      const signedUrl = await getSignedUrl(currentAgentId);
      const conversation = await Conversation.startSession({
        signedUrl,
        onConnect: () => {
          setIsConnected(true);
          setIsSpeaking(true);
          if (agentType === 'inbound') startRecording();
        },
        onDisconnect: () => {
          setIsConnected(false);
          setIsSpeaking(false);
          setIsLoading(false);
        },
        clientTools: {
          gibbMode: async () => {
            try {
              await conversation.endSession();
              const nextMessage = 'is it better now?';
              setLLMChat(prevChat => [...prevChat, {
                role: 'assistant', content: '[GL MODE]: yep, GL mode activated'
              }, {
                role: 'user', content: '[GL MODE]: ' + nextMessage
              }]);
              setGlMode(true);
              setConversation(null);
              await startRecording();
              setLatestUserMessage(nextMessage);
              await sendAudioMessage(nextMessage, agentType === 'inbound');
            } catch (error) {
              console.error('Error in gibbMode:', error);
            }
            return 'entering GibberLink mode';
          }
        },
        onMessage: handleMessage,
        onError: (error) => {
          console.log(error);
          alert('An error occurred during the conversation');
        },
        onModeChange: ({ mode }) => setIsSpeaking(mode === 'speaking'),
      });
      setConversation(conversation);
    } catch (error) {
      console.error('Error starting conversation:', error);
      alert('An error occurred while starting the conversation');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <Script src="/ggwave/ggwave.js" strategy="afterInteractive" />
      <div className="fixed inset-0">
        {latestUserMessage && (
          <div
            key={`message-${latestUserMessage}`}
            className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-[200px] z-10 text-3xl md:text-5xl w-full px-8 text-center font-normal"
            style={{
              color: 'white',
              wordBreak: 'break-word',
              textShadow: `
                -1px -1px 0 #000,  
                 1px -1px 0 #000,
                -1px 1px 0 #000,
                 1px 1px 0 #000,
                 0px 0px 8px rgba(0,0,0,0.5)`
            }}>
            {latestUserMessage}
          </div>
        )}

        <div className="h-full w-full flex items-center justify-center">
          <div id="audioviz" style={{ marginLeft: "-150px", width: "400px", height: "300px", display: glMode ? 'block' : 'none' }} />
          {!glMode && (
            <div className={cn('orb',
              isSpeaking ? 'animate-orb' : (conversation && 'animate-orb-slow'),
              isConnected || glMode ? 'orb-active' : 'orb-inactive',
              agentType)}
              onClick={() => {
                if (!conversation && !isConnected && !isLoading) {
                  const newAgentType = agentType === 'inbound' ? 'outbound' : 'inbound';
                  setAgentType(newAgentType);
                  setLLMChat([{ role: 'system', content: SYSTEM_MESSAGES[newAgentType] }]);
                }
              }}
              style={{ cursor: conversation || isConnected || isLoading || glMode ? 'default' : 'pointer' }}>
            </div>
          )}
        </div>

        {mounted && (
          <div className="fixed bottom-[40px] md:bottom-[60px] left-1/2 transform -translate-x-1/2">
            <Button
              variant={'outline'}
              className={'rounded-full select-none'}
              size={"lg"}
              disabled={isLoading}
              onClick={conversation || isConnected || glMode ? endConversation : startConversation}
              tabIndex={-1}
            >
              {isLoading ? 'Connecting...' : (conversation || isConnected || glMode ? 'End conversation' : 'Start conversation')}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
