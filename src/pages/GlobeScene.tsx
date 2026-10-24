import { useRef, useState, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Sphere, Html, useTexture } from '@react-three/drei';
import { COCO_STORY, STORIES } from '../data/stories';
import type { Story } from '../data/stories';
import { useNavigate } from 'react-router-dom';

interface NodeProps {
  story: Story;
  position: [number, number, number];
  onHover: (story: Story | null) => void;
  onClick: (story: Story) => void;
}

function latLngToCartesian(lat: number, lng: number, radius: number): [number, number, number] {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

function StoryNode({ story, position, onHover, onClick }: NodeProps) {
  const meshRef = useRef<any>(null);
  const [hovered, setHovered] = useState(false);
  const size = story.isCoco ? 0.055 : 0.028;

  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.3;
    }
  });

  return (
    <group position={position}>
      <Sphere
        ref={meshRef}
        args={[size, 16, 16]}
        onPointerEnter={(e) => {
          e.stopPropagation();
          setHovered(true);
          onHover(story);
        }}
        onPointerLeave={() => {
          setHovered(false);
          onHover(null);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClick(story);
        }}
      >
        <meshStandardMaterial
          color={story.isCoco ? '#F5E6D3' : '#B8B8A6'}
          emissive={story.isCoco ? '#F5E6D3' : '#A8B5A0'}
          emissiveIntensity={hovered ? 1.8 : story.isCoco ? 0.9 : 0.5}
          roughness={0.2}
          metalness={0.3}
        />
      </Sphere>

      {/* Glow ring for CoCo */}
      {story.isCoco && (
        <Sphere args={[size * 1.5, 16, 16]}>
          <meshStandardMaterial
            color="#F5E6D3"
            transparent
            opacity={hovered ? 0.15 : 0.07}
            emissive="#F5E6D3"
            emissiveIntensity={0.3}
          />
        </Sphere>
      )}

      {/* Pulse ring */}
      <Sphere args={[size * 2.2, 12, 12]}>
        <meshStandardMaterial
          color={story.isCoco ? '#F5E6D3' : '#A8B5A0'}
          transparent
          opacity={hovered ? 0.04 : 0.02}
          wireframe
        />
      </Sphere>

      {hovered && (
        <Html center distanceFactor={8} style={{ pointerEvents: 'none' }}>
          <div
            style={{
              background: 'rgba(30, 25, 15, 0.92)',
              border: '1px solid rgba(245, 230, 211, 0.25)',
              borderRadius: '12px',
              padding: '10px 14px',
              color: '#F5E6D3',
              whiteSpace: 'nowrap',
              fontFamily: 'system-ui, sans-serif',
              backdropFilter: 'blur(12px)',
              maxWidth: '200px',
            }}
          >
            <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '3px' }}>
              {story.city}，{story.country}
            </div>
            <div style={{ fontSize: '13px', fontWeight: 500 }}>{story.title}</div>
            <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '3px' }}>
              {story.name}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}

function Globe() {
  const globeRef = useRef<any>(null);
  const [hoveredStory, setHoveredStory] = useState<Story | null>(null);
  const navigate = useNavigate();

  useFrame((_, delta) => {
    if (globeRef.current) {
      globeRef.current.rotation.y += delta * 0.04;
    }
  });

  const allStories = [COCO_STORY, ...STORIES];
  const radius = 2;

  const handleClick = useCallback((story: Story) => {
    navigate(`/story/${story.id}`);
  }, [navigate]);

  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[10, 10, 10]} intensity={1.2} color="#fff8f0" />
      <pointLight position={[-10, -10, -10]} intensity={0.3} color="#B8B8A6" />

      {/* Earth sphere */}
      <Sphere ref={globeRef} args={[radius, 64, 64]}>
        <meshStandardMaterial
          color="#3D3020"
          roughness={0.8}
          metalness={0.1}
          transparent
          opacity={0.55}
        />
      </Sphere>

      {/* Wireframe grid rings */}
      {Array.from({ length: 6 }).map((_, i) => (
        <Sphere key={i} args={[radius + 0.01 + i * 0.003, 24, 24]}>
          <meshStandardMaterial
            color="#A8B5A0"
            wireframe
            transparent
            opacity={0.03}
          />
        </Sphere>
      ))}

      {/* Story nodes */}
      {allStories.map((story) => {
        const pos = latLngToCartesian(story.lat, story.lng, radius + 0.08);
        return (
          <StoryNode
            key={story.id}
            story={story}
            position={pos}
            onHover={setHoveredStory}
            onClick={handleClick}
          />
        );
      })}

      <OrbitControls
        enableZoom={true}
        enablePan={false}
        minDistance={3}
        maxDistance={8}
        autoRotate={false}
        makeDefault
      />
    </>
  );
}

export function GlobeScene() {
  return (
    <div className="absolute inset-0">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 50 }}
        style={{ background: 'transparent' }}
        gl={{ antialias: true, alpha: true }}
      >
        <Globe />
      </Canvas>
    </div>
  );
}
