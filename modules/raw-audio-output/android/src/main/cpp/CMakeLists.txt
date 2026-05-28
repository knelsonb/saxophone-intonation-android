# v1.1 — Native build for raw-audio-output (TinySoundFont).
cmake_minimum_required(VERSION 3.18.1)
project(rawaudiooutput LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Optimise the render path. TSF is single-header so all of it gets pulled
# into synth.cpp; -O2 keeps build times sane while still vectorising the
# inner mix loop.
add_compile_options(-O2 -Wall -Wno-unused-function -Wno-unused-variable)

add_library(rawaudiooutput SHARED
    synth.cpp
    jni_bridge.cpp
)

target_include_directories(rawaudiooutput PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

find_library(log-lib log)
target_link_libraries(rawaudiooutput PRIVATE ${log-lib})

# 16 KB page-size compliance. Android 15+ devices with a 16 KB-page kernel
# (Pixel 9 series included) refuse to dlopen a .so whose LOAD segments are
# only 4 KB-aligned — a hard crash at launch. Force 16 KB max-page-size so the
# segments are aligned for both 4 KB and 16 KB kernels. (NDK 27+ defaults this
# on, but we set it explicitly so it can't regress on an older NDK.)
target_link_options(rawaudiooutput PRIVATE "-Wl,-z,max-page-size=16384")
