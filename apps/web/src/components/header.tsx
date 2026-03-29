"use client";

import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import React from "react";
import { useScroll, motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";

const menuItems = [
  { name: "Features", href: "#features" },
  { name: "Apps", href: "#apps" },
  { name: "Docs", href: "/docs" },
  { name: "GitHub", href: "https://github.com/talomehq/talome" },
];

const EASE = [0.2, 0.8, 0.2, 1] as const;

/**
 * Animated hamburger → cross toggle.
 * Two lines that rotate into an X — the crossing strands echo the DNA mark.
 */
function MenuToggle({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={open ? "Close Menu" : "Open Menu"}
      className="relative z-20 -m-2.5 -mr-4 flex size-10 cursor-pointer items-center justify-center lg:hidden"
    >
      <div className="relative flex h-4 w-5 flex-col justify-between">
        <motion.span
          className="block h-[1.5px] w-full origin-center rounded-full bg-foreground"
          animate={
            open
              ? { rotate: 45, y: 7, transition: { duration: 0.3, ease: EASE } }
              : { rotate: 0, y: 0, transition: { duration: 0.3, ease: EASE } }
          }
        />
        <motion.span
          className="block h-[1.5px] w-full origin-center rounded-full bg-foreground"
          animate={
            open
              ? {
                  rotate: -45,
                  y: -7,
                  transition: { duration: 0.3, ease: EASE },
                }
              : {
                  rotate: 0,
                  y: 0,
                  transition: { duration: 0.3, ease: EASE },
                }
          }
        />
      </div>
    </button>
  );
}

export const HeroHeader = () => {
  const [menuState, setMenuState] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const { scrollYProgress } = useScroll();

  React.useEffect(() => {
    const unsubscribe = scrollYProgress.on("change", (latest) => {
      setScrolled(latest > 0.05);
    });
    return () => unsubscribe();
  }, [scrollYProgress]);

  // Close menu on link click
  const handleLinkClick = () => setMenuState(false);

  return (
    <header>
      <nav className="fixed z-20 w-full pt-2">
        <div
          className={cn(
            "mx-auto max-w-7xl rounded-3xl px-6 transition-all duration-300 lg:px-12",
            scrolled &&
              "bg-background/60 backdrop-blur-xl shadow-[0_1px_0_0_rgba(255,255,255,0.04)]"
          )}
        >
          <div
            className={cn(
              "relative flex items-center justify-between py-3 lg:py-6",
              scrolled && "lg:py-4"
            )}
            style={{
              transition: "padding 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)",
            }}
          >
            <Link href="/" aria-label="home" className="flex items-center">
              <Logo />
            </Link>

            {/* Desktop nav */}
            <div className="hidden lg:flex lg:items-center lg:gap-10">
              {menuItems.map((item, index) => (
                <Link
                  key={index}
                  href={item.href}
                  className="text-sm text-muted-foreground/60 transition-colors duration-150 hover:text-primary"
                >
                  {item.name}
                </Link>
              ))}
              <Button
                asChild
                size="sm"
                variant="outline"
                className="rounded-full border-border/20 px-5 text-sm text-muted-foreground hover:text-foreground"
              >
                <Link href="#install">Install Talome</Link>
              </Button>
            </div>

            {/* Mobile toggle */}
            <MenuToggle
              open={menuState}
              onClick={() => setMenuState(!menuState)}
            />
          </div>
        </div>

        {/* Mobile menu — animated overlay */}
        <AnimatePresence>
          {menuState && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="absolute inset-x-0 top-full px-6 pt-2 lg:hidden"
            >
              <div className="overflow-hidden rounded-2xl border border-border/20 bg-background/95 shadow-2xl backdrop-blur-2xl">
                <nav className="p-6">
                  <ul className="space-y-1">
                    {menuItems.map((item, index) => (
                      <motion.li
                        key={index}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{
                          duration: 0.25,
                          ease: EASE,
                          delay: 0.04 * index,
                        }}
                      >
                        <Link
                          href={item.href}
                          onClick={handleLinkClick}
                          className="block rounded-lg px-3 py-3 text-base text-muted-foreground/80 transition-colors duration-150 hover:bg-foreground/[0.04] hover:text-foreground"
                        >
                          {item.name}
                        </Link>
                      </motion.li>
                    ))}
                  </ul>
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2, delay: 0.2 }}
                    className="mt-4 border-t border-border/10 pt-4"
                  >
                    <Button
                      asChild
                      className="w-full rounded-xl"
                      onClick={handleLinkClick}
                    >
                      <Link href="#install">Install Talome</Link>
                    </Button>
                  </motion.div>
                </nav>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>
    </header>
  );
};
