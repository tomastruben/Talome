import HeroSection from "@/components/hero-section";
import { StorySection } from "@/components/story-section";
import { FeatureExperience } from "@/components/feature-experience";
import AppEcosystem from "@/components/app-ecosystem";
import { OwnershipSection } from "@/components/ownership-section";
import CallToAction from "@/components/call-to-action";
import FooterSection from "@/components/footer";
export default function Home() {
  return (
    <>
      <HeroSection />
      <StorySection />
      <FeatureExperience />
      <AppEcosystem />
      <OwnershipSection />
      <CallToAction />
      <FooterSection />
    </>
  );
}
